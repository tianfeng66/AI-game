/* This entry deliberately has no static imports: even a failed engine import gets a visible error. */
(function () {
  const restartHint = '请在启动游戏的终端按 Ctrl+C，重新运行 npm.cmd start，然后刷新此页。';
  const portHint = '若终端提示端口被占用（EADDRINUSE），说明这个端口是别的程序在服务：请换端口启动，例如 PORT=8081 npm start，并打开 http://localhost:8081（网页会自动跟随端口）。';

  async function runStartup({ fetcher, loadModule, report, signal }) {
    report(5, '检查游戏服务', '确认服务版本与地图文件');
    const response = await fetcher('/health', { cache: 'no-store', signal });
    if (!response.ok) throw new Error('游戏服务未更新或地址不正确：这个端口可能已被其他程序占用，或浏览器地址与服务端口不一致。' + portHint + restartHint);
    let health;
    try { health = await response.json(); } catch { throw new Error('当前地址不是新版游戏服务。' + portHint + restartHint); }
    if (health.game && health.game !== 'stickman-territory') throw new Error('当前端口是其他程序的服务，不是游戏服务。' + portHint);
    if (health.protocol !== 2) throw new Error('页面与游戏服务版本不一致。' + restartHint);
    if (!health.rendererReady) throw new Error('缺少本地 3D 引擎文件。请在 skeleton 目录执行 npm.cmd install，再重启游戏服务。');
    signal.throwIfAborted();
    report(15, '读取地图数据', '加载森林、矿场和基地布局');
    await loadModule('./world.js');
    signal.throwIfAborted();
    report(25, '加载 3D 引擎', '正在读取本地渲染文件；阶段完成后进度会更新');
    const game = await loadModule('./game.js');
    signal.throwIfAborted();
    await game.startGame(report, signal);
    signal.throwIfAborted();
    report(100, '地图已就绪', '已完成地图绘制并连接游戏服务');
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = { runStartup }; return; }
  const $ = id => document.getElementById(id);
  const controller = new AbortController();
  const started = performance.now();
  let status = 'loading', stage = '启动加载器';
  const elapsed = () => Math.floor((performance.now() - started) / 1000);
  function report(percent, title, detail) {
    if (status !== 'loading') return;
    stage = title;
    $('load-progress').value = percent;
    $('load-percent').textContent = percent + '%';
    $('load-stage').textContent = title;
    $('load-detail').textContent = detail;
    $('join-button').textContent = percent === 100 ? '进入河谷' : title + '…';
  }
  function fail(error) {
    if (status !== 'loading') return;
    status = 'failed'; clearInterval(ticker); clearTimeout(deadline);controller.abort();
    console.error('Game startup failed:', error);
    $('loading').classList.add('failed');
    $('load-stage').textContent = '加载失败 · ' + stage;
    $('load-detail').textContent = error.message || '地图启动失败，请重新加载。';
    $('load-time').textContent = '已停止等待';
    $('join-button').textContent = '地图尚未就绪';$('join-button').disabled = true;
    $('retry-load').classList.remove('hidden');
    $('connection').textContent = '启动失败';
  }
  $('retry-load').onclick = () => location.reload();
  const ticker = setInterval(() => {
    $('load-time').textContent = `已用 ${elapsed()} 秒`;
  }, 500);
  const deadline = setTimeout(() => fail(new Error(`“${stage}”超过 30 秒仍未完成，已停止等待。请检查游戏服务是否运行，再点击重新加载。`)), 30000);
  window.addEventListener('error', event => {
    if (event.error) fail(event.error);
  });
  window.addEventListener('unhandledrejection', event => fail(event.reason instanceof Error ? event.reason : new Error(String(event.reason))));
  if (!/^https?:$/.test(location.protocol)) {
    fail(new Error('请通过 http://localhost:8080 打开游戏，不要直接双击 HTML 文件。'));
    return;
  }
  runStartup({
    fetcher: (url, options) => fetch(url, options),
    loadModule: async url => {
      try { return await import(url); }
      catch (error) { throw new Error(`文件加载失败（${url}）。请检查服务是否已重启，或按 Ctrl+F5 刷新。详细信息：${error.message}`); }
    },
    report,
    signal: controller.signal,
  }).then(() => {
    if (status !== 'loading') return;
    status = 'ready';clearInterval(ticker);clearTimeout(deadline);
    $('loading').classList.add('ready');
    $('load-time').textContent = `共用 ${elapsed()} 秒`;
    $('join-button').disabled = false;
  }).catch(fail);
})();
