'use strict';
// Starts an isolated server, exercises real HTTP / WebSocket messages, then stops it.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
const port = 18081;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(port) }, windowsHide: true });
const clients = [];
function waitFor(predicate, description, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('Timeout: ' + description)); }
    }, 25);
  });
}
async function connect(name, clientId) {
  const client = { ws: new WebSocket(`ws://127.0.0.1:${port}`), state: null, id: null, rules: null, rejected: null };
  clients.push(client);
  client.ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.type === 'welcome') { client.id = m.faction; client.rules = m.rules; }
    if (m.type === 'join_rejected') client.rejected = m.error;
    if (m.type === 'state') client.state = m;
    if (m.type === 'action_result') client.lastAction = m;
  });
  await new Promise((resolve, reject) => { client.ws.once('open', resolve); client.ws.once('error', reject); });
  client.send = data => client.ws.send(JSON.stringify(data));
  client.send({ type: 'join', name, ...(clientId ? { clientId } : {}) });
  await waitFor(() => client.state || client.rejected, 'join state');
  return client;
}
(async () => {
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server did not start')), 8000);
      server.stdout.on('data', chunk => { if (chunk.toString().includes('http://localhost:')) { clearTimeout(timer); resolve(); } });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
      server.stderr.on('data', chunk => process.stderr.write(chunk));
    });
    const health = await (await fetch(origin+'/health')).json();
    assert.equal(health.protocol,2);assert.equal(health.rendererReady,true);
    assert.equal(health.game,'stickman-territory');assert.equal(health.port,port);
    for (const route of ['/', '/?v=2', '/vendor/three.module.js?v=2', '/startup.js', '/game.js', '/scene.js', '/world.js', '/style.css', '/loading.css', '/combat.css', '/construction.css', '/vendor/three.module.js', '/vendor/three.core.js']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200, route);
      if (route.endsWith('.js')) assert.match(response.headers.get('content-type'), /javascript/);
      assert.ok((await response.text()).length > 20, route);
    }
    console.log('✓ HTTP delivers the map, renderer and local Three.js modules');
    const a = await connect('视角测试 A');
    const b = await connect('视角测试 B');
    assert.equal(a.rules.towerBuildSeconds,12,'welcome 一次性下发规则');
    assert.ok(!('rules' in a.state),'20 Hz 状态包不再重复携带常量规则');
    a.send({ type: 'possess_switch' });
    await waitFor(() => a.state.you.possessedUnitId != null, 'possession');
    const id = a.state.you.possessedUnitId;
    await waitFor(() => b.state.units.some(u => u.id === id && u.possessed), 'remote possession state');
    const before = a.state.units.find(u => u.id === id).x;
    a.send({ type: 'control', dx: 1, dy: 0 });
    await waitFor(() => a.state.units.find(u => u.id === id).x > before + .4, 'movement');
    a.send({type:'control',dx:0,dy:0,attack:true,aimX:1,aimY:0});
    await waitFor(()=>b.state.units.some(u=>u.id===id&&u.attackSeq>0),'attack animation broadcast');
    const embodied=a.state.units.find(u=>u.id===id);
    assert.equal(embodied.maxHp,96);
    assert.equal(embodied.attack,6);
    a.send({ type: 'release' });
    await waitFor(() => a.state.you.possessedUnitId == null && b.state.units.some(u => u.id === id && !u.possessed), 'release sync');
    console.log('✓ Two clients agree on possession, movement and returning to overview');
    console.log('✓ Attack animation and +20% attack/HP are authoritative and visible to both clients');
    a.lastAction=null;a.send({type:'begin_build'});
    await waitFor(()=>a.lastAction?.ok&&a.state.you.buildBudgetProtected,'preview budget protection');
    const previewGold=a.state.you.resources.gold,previewWood=a.state.you.resources.wood;
    a.lastAction=null;a.send({type:'build_tower',x:-34,y:17});
    await waitFor(()=>a.lastAction,'invalid placement reply');assert.equal(a.lastAction.ok,false);
    assert.equal(a.state.you.resources.gold,previewGold);assert.equal(a.state.you.resources.wood,previewWood);
    a.lastAction=null;a.send({type:'build_tower',x:-26,y:17,requestId:'test-place-once'});
    await waitFor(()=>a.lastAction?.ok&&a.state.sites.length===1&&b.state.sites.length===1,'construction site broadcast');
    assert.equal(a.state.towers.length,0);assert.equal(a.state.sites[0].duration,12);
    assert.equal(a.state.sites[0].workerId,id);
    const siteId=a.state.sites[0].id;
    a.lastAction=null;a.send({type:'build_tower',x:-26,y:17,requestId:'test-place-once'});
    await waitFor(()=>a.lastAction?.requestId==='test-place-once','idempotent placement');
    assert.equal(a.lastAction.ok,true);assert.equal(a.lastAction.siteId,siteId);assert.equal(a.state.sites.length,1);
    console.log('✓ Preview does not deduct materials; duplicate placement requests return the same result without charging twice');
    a.lastAction=null;a.send({type:'cancel_build',siteId:a.state.sites[0].id});
    await waitFor(()=>a.lastAction?.ok&&a.state.sites.length===0&&b.state.sites.length===0,'construction cancellation');
    console.log('✓ Invalid placement errors, worker assignment, construction progress and cancellation synchronize across clients');
    const group=a.state.units.filter(u=>u.faction===a.id).map(u=>u.id);
    const enemy=b.state.units.find(u=>u.faction===b.id);
    a.lastAction=null;a.send({type:'order_attack',unitIds:group,targetKind:'unit',targetId:enemy.id});
    await waitFor(()=>a.lastAction?.action==='order_attack'&&b.state.units.filter(u=>group.includes(u.id)).every(u=>u.order?.id===enemy.id),'group attack broadcast');
    assert.equal(a.lastAction.count,group.length);
    a.lastAction=null;a.send({type:'order_home',unitIds:group});
    await waitFor(()=>a.lastAction?.action==='order_home'&&b.state.units.some(u=>group.includes(u.id)&&u.order?.kind==='home'),'group return broadcast');
    assert.equal(a.lastAction.count,group.length);
    await waitFor(()=>a.state.units.filter(u=>group.includes(u.id)).every(u=>!u.order),'group resume AI',8000);
    console.log('✓ Group attack and home orders synchronize; all returning units clear manual orders at home');
    a.lastAction=null;a.send({type:'take_control',unitIds:group});
    await waitFor(()=>a.lastAction?.action==='take_control'&&b.state.units.filter(u=>group.includes(u.id)).every(u=>u.commanded),'take control sync');
    assert.equal(a.state.you.possessedUnitId,null);
    const moving=a.state.units.find(u=>u.id===id),destination={x:moving.x+3,y:moving.y+1};
    a.lastAction=null;a.send({type:'order_move',unitIds:group,...destination});
    await waitFor(()=>a.lastAction?.action==='order_move'&&b.state.units.some(u=>group.includes(u.id)&&u.order?.kind==='move'),'move order sync');
    await waitFor(()=>b.state.units.filter(u=>group.includes(u.id)).every(u=>!u.order&&u.commanded&&Math.hypot(u.x-destination.x,u.y-destination.y)<.01),'arrive and hold',8000);
    a.send({type:'cancel_order',unitIds:group});
    await waitFor(()=>b.state.units.filter(u=>group.includes(u.id)).every(u=>!u.commanded),'resume autonomous jobs');
    console.log('✓ RTS control and click destinations synchronize without possession; units arrive, hold, and resume AI on cancellation');
    b.send({ type: 'surrender' });
    for (const f of a.state.factions) if (f.id >= 1000) {
      // Joining the existing AI faction leaves one active faction after A surrenders.
      a.send({ type: 'join_faction', target: f.id });
    }
    a.send({ type: 'surrender' });
    await waitFor(() => a.state.matchState === 'over', 'match ending');
    a.send({ type: 'restart' });
    await waitFor(() => a.state.matchState === 'running' && b.state.matchState === 'running', 'shared restart');
    assert.ok(a.state.timeLeft > 590);
    assert.equal(a.state.nodes.length, 24);
    assert.equal(a.state.you.possessedUnitId, null);
    assert.ok(a.state.units.some(u => u.faction === a.id));
    assert.ok(b.state.units.some(u => u.faction === b.id));
    a.lastAction=null;a.send({type:'begin_build'});
    await waitFor(()=>a.lastAction?.ok&&a.state.you.buildBudgetProtected,'new round preview');
    a.lastAction=null;a.send({type:'build_tower',x:-26,y:17,requestId:'test-place-once'});
    await waitFor(()=>a.lastAction?.ok&&a.state.sites.length===1&&b.state.sites.length===1,'request ID reused in new round');
    assert.equal(a.state.you.resources.wood,0);
    console.log('PASS Restart resets build request cache and charges the new site');
    console.log('✓ Restart creates a fresh shared map and restores both players');

    const rc = await connect('重连测试','network-test-reconnect');
    const rcId = rc.id;
    assert.ok(rcId != null,'重连测试客户端成功加入');
    rc.ws.close();
    await new Promise(resolve=>setTimeout(resolve,350));
    const rcFaction = a.state.factions.find(f=>f.id===rcId);
    assert.ok(rcFaction && !rcFaction.surrendered,'掉线后阵营仍存活，未立即判负');
    assert.ok(a.state.bases.some(b=>b.faction===rcId),'掉线后基地与单位继续由 AI 自治');
    const rc2 = await connect('重连测试','network-test-reconnect');
    assert.equal(rc2.id,rcId,'同一 clientId 重连恢复原阵营');
    console.log('✓ Disconnect keeps the faction alive; reconnect restores the original faction');

    // a + b + the reconnect player = 3; seven more fill the remaining slots.
    let admitted=0,rejected=null;
    for(let i=0;i<8;i++){
      const c=await connect('满员测试'+i);
      if(c.id!=null)admitted++;
      else rejected=c.rejected;
    }
    assert.equal(admitted,7,'补满到第 10 人');
    assert.ok(rejected&&/已满/.test(rejected),'第 11 人收到明确的满员拒绝');
    console.log('✓ Player cap enforced at 10; the 11th join is rejected with a readable error');
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    for (const client of clients) client.ws.terminate();
    server.kill();
  }
})();
