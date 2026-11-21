'use strict';
// 火柴人领地 —— 服务端入口（静态文件 + WebSocket + 游戏循环）
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createGame } = require('./game');

const PORT = Number(process.env.PORT) || 8080;
const RECONNECT_GRACE_MS = 60 * 1000;
let game = createGame();
let roundId = 1;

// 静态文件服务（托管 client/）
const clientRoot = path.join(__dirname, '..', 'client');
const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/health') {
    const rendererReady = ['three.module.js', 'three.core.js'].every(name => fs.existsSync(path.join(__dirname, '../node_modules/three/build', name)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ protocol: 2, rendererReady, game: 'stickman-territory', port: PORT }));
    return;
  }
  // Serve the pinned local renderer; playing does not depend on an external CDN.
  const vendor = { '/vendor/three.module.js': 'three.module.js', '/vendor/three.core.js': 'three.core.js' };
  if (Object.hasOwn(vendor, pathname)) {
    const file = path.join(__dirname, '../node_modules/three/build', vendor[pathname]);
    fs.readFile(file, (err, data) => {
      res.writeHead(err ? 404 : 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(err ? 'Renderer missing: run npm install' : data);
    });
    return;
  }
  const urlPath = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(clientRoot, path.normalize(urlPath));
  if (!full.startsWith(clientRoot + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被其他程序占用，游戏服务无法启动。`);
    console.error('请关闭占用该端口的程序，或换一个端口启动（网页客户端会自动跟随端口）：');
    console.error('  Git Bash   : PORT=8081 npm start');
    console.error('  CMD        : set PORT=8081 && npm start');
    console.error('  PowerShell : $env:PORT=8081; npm start');
    console.error(`然后打开 http://localhost:8081\n`);
  } else {
    console.error('游戏服务启动失败:', error);
  }
  process.exit(1);
});

const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
let nextFaction = 1;
// clientId -> { clientId, factionId, name, ws, offlineTimer }
// A disconnect keeps the faction alive for a grace period so a refresh or a
// flaky network can reclaim it instead of instantly losing the match.
const sessions = new Map();

function welcome(ws, factionId, name) {
  ws.send(JSON.stringify({ type: 'welcome', faction: factionId, name, rules: game.rulesSnapshot() }));
}

function attachClient(ws, session) {
  const previous = session.ws;
  if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
    previous._factionId = null;
    previous.send(JSON.stringify({ type: 'session_taken_over' }));
    previous.close();
  }
  if (session.offlineTimer) { clearTimeout(session.offlineTimer); session.offlineTimer = null; }
  session.ws = ws;
  ws._factionId = session.factionId;
  ws._clientId = session.clientId;
  ws._playerName = session.name;
  ws._buildReplies = ws._buildReplies || new Map();
  welcome(ws, session.factionId, session.name);
}

function goOffline(session) {
  // Hand the possessed unit back to its AI, but keep the faction and its units.
  game.handleMessage(session.factionId, { type: 'release' });
  session.ws = null;
  session.offlineTimer = setTimeout(() => {
    if (session.ws) return;
    game.handleMessage(session.factionId, { type: 'surrender' });
    sessions.delete(session.clientId);
    console.log(`玩家 ${session.name}（阵营 ${session.factionId}）离线超过 ${RECONNECT_GRACE_MS / 1000} 秒，已判出局`);
  }, RECONNECT_GRACE_MS);
}

wss.on('connection', (ws) => {
  ws._factionId = null;
  ws._clientId = null;
  ws._buildReplies = new Map();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'join') {
        if (ws._factionId != null) return;
        const clientId = typeof msg.clientId === 'string' && msg.clientId.length <= 64 ? msg.clientId : null;
        if (clientId && sessions.has(clientId)) {
          attachClient(ws, sessions.get(clientId));
          return;
        }
        const factionId = nextFaction;
        const name = String(msg.name || ('P' + factionId)).slice(0, 16);
        if (Object.keys(game.players).length >= game.maxPlayers) {
          ws.send(JSON.stringify({ type: 'join_rejected', error: `本局已满（最多 ${game.maxPlayers} 人），请等待下一局` }));
          return;
        }
        if (!game.registerPlayer(factionId, name)) {
          ws.send(JSON.stringify({ type: 'join_rejected', error: '当前没有可用的出生点，请等待下一局' }));
          return;
        }
        nextFaction++;
        const session = { clientId, factionId, name, ws, offlineTimer: null };
        if (clientId) sessions.set(clientId, session);
        ws._factionId = factionId;
        ws._clientId = clientId;
        ws._playerName = name;
        welcome(ws, factionId, name);
        return;
      }
      if (['restart','end_game'].includes(msg.type) && msg.roundId != null && msg.roundId !== roundId) return;
      if (msg.type === 'restart' && ws._factionId != null &&
          (game.state === 'over' || (game.state === 'running' && msg.roundId === roundId))) {
        roundId++;
        game = createGame();
        for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client._buildReplies.clear();
        for (const session of sessions.values()) game.registerPlayer(session.factionId, session.name);
        // Legacy clients without a clientId are still re-registered for the new round.
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN && client._factionId != null && !client._clientId) {
            game.registerPlayer(client._factionId, client._playerName || ('P' + client._factionId));
          }
        }
        return;
      }
      if (ws._factionId != null) {
        const requestId=msg.type==='build_tower'&&typeof msg.requestId==='string'&&msg.requestId.length<=80?msg.requestId:null;
        if(requestId&&ws._buildReplies.has(requestId)){ws.send(JSON.stringify(ws._buildReplies.get(requestId)));return;}
        const result=game.handleMessage(ws._factionId, msg);
        if(result){
          const reply={type:'action_result',action:msg.type,...result};
          if(requestId){reply.requestId=requestId;ws._buildReplies.set(requestId,reply);if(ws._buildReplies.size>64)ws._buildReplies.delete(ws._buildReplies.keys().next().value);}
          ws.send(JSON.stringify(reply));
        }
      }
    } catch (e) { console.error('消息错误:', e.message); }
  });

  ws.on('close', () => {
    if (ws._factionId == null) return; // already handed over to a newer connection
    const session = ws._clientId ? sessions.get(ws._clientId) : null;
    if (session && session.ws === ws) goOffline(session);
    else if (!session) game.handleMessage(ws._factionId, { type: 'release' });
  });
});

// 游戏循环：20 tick/秒，向各客户端广播其视角状态
setInterval(() => {
  game.tick(1 / 20);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client._factionId != null) {
      client.send(JSON.stringify({...game.serializeFor(client._factionId), roundId}));
    }
  }
}, 50);

server.listen(PORT, () => {
  console.log('火柴人领地 服务端已启动: http://localhost:' + PORT);
  console.log('本机测试：开两个浏览器标签页分别进入即可 2 人对战');
});
