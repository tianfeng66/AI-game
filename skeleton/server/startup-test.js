'use strict';
const assert = require('node:assert/strict');
const { runStartup } = require('../client/startup');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(overrides = {}) {
  const reports = [], controller = new AbortController();
  const deps = {
    fetcher: async () => ({ok:true,json:async()=>({protocol:2,rendererReady:true})}),
    loadModule: async url => url.endsWith('game.js') ? {startGame:async report=>report(92,'连接游戏服务','地图已生成')} : {},
    report: (...args)=>reports.push(args), signal:controller.signal, ...overrides,
  };
  return {deps,reports,controller};
}
(async()=>{
  const success=fixture();await runStartup(success.deps);
  assert.equal(success.reports.at(-1)[0],100);
  assert.ok(success.reports.every((r,i,list)=>i===0||r[0]>=list[i-1][0]));
  console.log('✓ Only completed startup reaches 100%; stage progress is monotonic');
  for(const [label,override,expected] of [
    ['old server 404',{fetcher:async()=>({ok:false})},/服务未更新/],
    ['wrong service JSON',{fetcher:async()=>({ok:true,json:async()=>{throw new Error('HTML');}})},/不是新版/],
    ['missing renderer',{fetcher:async()=>({ok:true,json:async()=>({protocol:2,rendererReady:false})})},/npm.cmd install/],
    ['engine import failure',{loadModule:async()=>{throw new Error('engine missing');}},/engine missing/],
    ['WebGL failure',{loadModule:async()=>({startGame:async()=>{throw new Error('WebGL unavailable');}})},/WebGL/],
    ['WebSocket failure',{loadModule:async()=>({startGame:async()=>{throw new Error('connection timeout');}})},/connection timeout/],
  ]){
    const f=fixture(override);await assert.rejects(runStartup(f.deps),expected);
    assert.ok(!f.reports.some(r=>r[0]===100));console.log('✓ Failure propagated without false completion: '+label);
  }
  const aborted=fixture();aborted.controller.abort();await assert.rejects(runStartup(aborted.deps),{name:'AbortError'});
  console.log('✓ Cancelled startup cannot enable entry');

  // Execute the actual classic entry in a small DOM/timer harness. No browser or graphics dependency.
  const elements = new Map();
  const getElement=id=>{
    if(!elements.has(id)){const classes=new Set(id==='retry-load'?['hidden']:[]);elements.set(id,{textContent:'',disabled:id==='join-button',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)}});}
    return elements.get(id);
  };
  let deadline,resolveFetch;
  const context={
    document:{getElementById:getElement},performance:{now:()=>0},AbortController,
    location:{protocol:'http:',reload(){}},console:{error(){}},
    setInterval:()=>1,clearInterval(){},setTimeout:(fn,ms)=>{if(ms===30000)deadline=fn;return 2;},clearTimeout(){},
    window:{addEventListener(){}},fetch:()=>new Promise(resolve=>{resolveFetch=resolve;}),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/startup.js'),'utf8'),context);
  assert.equal(typeof deadline,'function');deadline();
  assert.match(getElement('load-stage').textContent,/加载失败/);
  assert.match(getElement('load-detail').textContent,/30 秒/);
  assert.equal(getElement('retry-load').classList.contains('hidden'),false);
  assert.equal(getElement('join-button').disabled,true);
  const timeoutMessage=getElement('load-detail').textContent;
  resolveFetch({ok:true,json:async()=>({protocol:2,rendererReady:true})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(getElement('load-detail').textContent,timeoutMessage);
  assert.equal(getElement('join-button').disabled,true);
  console.log('✓ 30-second watchdog shows an error and retry; late responses cannot revive failed startup');
})().catch(error=>{console.error(error);process.exitCode=1;});
