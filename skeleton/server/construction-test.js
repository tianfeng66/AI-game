'use strict';
const assert=require('node:assert/strict');
const {createGame,UnitType,Config}=require('./game');
const World=require('../client/world');
function setup(){
  const g=createGame();g.registerPlayer(1,'A');g.registerPlayer(2,'B');g.tick(.05);
  for(const u of g.units){u.thinkTimer=1e6;u.moveX=u.moveY=0;}
  for(const b of g.bases)b.spawnTimer=1e6;
  g.factions[1].resources={gold:300,food:1000,wood:300,ore:100};g.factions[2].resources.food=1000;
  return {g,worker:g.units.find(u=>u.faction===1&&u.type===UnitType.Worker)};
}
function advance(g,seconds){for(let i=0;i<Math.round(seconds/.05);i++)g.tick(.05);}
function place(g,x=-26,y=17){return g.handleMessage(1,{type:'build_tower',x,y});}
{
  const {g,worker}=setup();worker.hp=40;advance(g,9.95);assert.equal(worker.hp,40);advance(g,.05);assert.ok(Math.abs(worker.hp-40.8)<1e-8);
  advance(g,10);assert.ok(Math.abs(worker.hp-41.6)<1e-8);
  worker.hp=79.9;worker.regenTimer=0;advance(g,10);assert.equal(worker.hp,80);
  const tower={id:9999,faction:1,x:-40,y:40,hp:50,maxHp:200,lastAttack:0};g.towers.push(tower);advance(g,10);assert.equal(tower.hp,50);
  g.handleMessage(1,{type:'possess',unitId:worker.id});worker.hp=48;worker.regenTimer=0;advance(g,10);assert.ok(Math.abs(worker.hp-48.96)<1e-8);
  console.log('✓ 人物每 10 秒恢复最大生命 1%，不提前回血、不超过上限，化身生命加成计入；建筑不回血');
}
{
  const {g,worker}=setup();const gold=g.factions[1].resources.gold,wood=g.factions[1].resources.wood;
  assert.equal(place(g).ok,true);assert.equal(g.factions[1].resources.gold,gold-15);assert.equal(g.factions[1].resources.wood,wood-30);
  const site=g.sites[0];assert.equal(site.workerId,worker.id);assert.equal(g.towers.length,0);
  advance(g,.2);assert.equal(site.progress,0);assert.equal(site.status,'travel');assert.ok(worker.x>-31);
  worker.x=site.x;worker.y=site.y;advance(g,11.95);assert.equal(g.towers.length,0);assert.equal(site.status,'building');
  advance(g,.05);assert.equal(g.sites.length,0);assert.equal(g.towers.length,1);assert.equal(worker.buildSiteId,null);
  assert.equal(g.towers[0].x,-26);assert.equal(g.towers[0].y,17);
  console.log('✓ 成本只扣一次，工人先赶路，到场施工完整 12 秒后生成箭塔并解除工人任务');
}
{
  const {g,worker}=setup();const gold=g.factions[1].resources.gold;
  for(const [x,y] of [[0,0],[NaN,0],[Infinity,0],[49,0],[-34,17],[-26,-22]])assert.equal(place(g,x,y).ok,false);
  assert.equal(g.factions[1].resources.gold,gold);
  g.handleMessage(1,{type:'possess',unitId:worker.id});assert.equal(place(g).ok,false);assert.equal(g.sites.length,0);
  g.handleMessage(1,{type:'release'});assert.equal(place(g).ok,true);
  assert.equal(place(g).ok,false);assert.equal(place(g,-38,30).ok,false);
  console.log('✓ 越界、河道、资源区、重叠和无可用工人均拒绝施工，失败不扣资源');
}
{
  const {g,worker}=setup();place(g);const site=g.sites[0];worker.x=site.x;worker.y=site.y;advance(g,2);
  const progress=site.progress;g.handleMessage(1,{type:'possess',unitId:worker.id});advance(g,1);
  assert.equal(site.progress,progress);assert.equal(site.status,'waiting');
  g.handleMessage(1,{type:'release'});advance(g,.1);assert.equal(site.workerId,worker.id);assert.ok(site.progress>progress);
  const before=g.factions[1].resources.gold;const result=g.handleMessage(2,{type:'cancel_build',siteId:site.id});assert.equal(result.ok,false);
  const cancelled=g.handleMessage(1,{type:'cancel_build',siteId:site.id});assert.equal(cancelled.ok,true);assert.equal(g.sites.length,0);assert.equal(worker.buildSiteId,null);assert.equal(g.factions[1].resources.gold,before+cancelled.gold);
  console.log('✓ 接管工人会暂停施工，释放后接替；敌人不能取消工地，己方取消退回未完成部分资源');
}
{
  const {g,worker}=setup();place(g);const site=g.sites[0];
  const replacement={...worker,id:999,buildSiteId:null,x:-30,y:17,carried:{gold:0,food:0,wood:0,ore:0}};g.units.push(replacement);
  g.units.splice(g.units.indexOf(worker),1);advance(g,.1);assert.equal(site.workerId,999);
  g.handleMessage(1,{type:'surrender'});assert.equal(g.sites.length,0);
  console.log('✓ 施工工人阵亡时自动改派可用工人，阵营退出清除施工现场');
}
assert.equal(World.placementError(-26,17,{bases:[{x:-34,y:17,faction:1}],towers:[],sites:[],nodes:[]},1), '');
{
  const {g}=setup();const resources={...g.factions[1].resources};
  g.bases.find(b=>b.faction===1).spawnTimer=.05;
  assert.equal(g.handleMessage(1,{type:'begin_build'}).ok,true);
  for(let i=0;i<6;i++){advance(g,3);g.handleMessage(1,{type:'build_preview_keepalive'});}
  assert.equal(g.factions[1].resources.gold,resources.gold);assert.equal(g.factions[1].resources.wood,resources.wood);assert.equal(g.sites.length,0);
  assert.equal(g.serializeFor(1).you.buildBudgetProtected,true);
  assert.equal(place(g,-10,17).ok,false);assert.equal(g.factions[1].resources.gold,resources.gold);
  g.handleMessage(1,{type:'end_build'});advance(g,.05);assert.equal(g.factions[1].resources.gold,resources.gold-10);
  console.log('✓ 选址 18 秒不扣金币木材，自动出兵暂停；超范围确认失败不扣费；取消恢复出兵');
}
{
  const {g}=setup();const gold=g.factions[1].resources.gold;g.handleMessage(1,{type:'begin_build'});
  assert.equal(place(g).ok,true);assert.equal(g.factions[1].resources.gold,gold-15);assert.equal(g.serializeFor(1).you.buildBudgetProtected,false);
  assert.match(World.placementError(20,-20,g,1),/18 格/);
  const nearbyBase={id:9999,x:20,y:12,faction:1};g.bases.push(nearbyBase);
  assert.equal(World.placementError(12,12,g,1),'');nearbyBase.faction=2;assert.match(World.placementError(12,12,g,1),/18 格/);
  console.log('✓ 仅放置成功扣一次材料，己方基地都提供建造范围，敌方或失去的基地不提供范围');
}
{
  const {g}=setup();g.handleMessage(1,{type:'begin_build'});advance(g,10.1);
  assert.equal(g.serializeFor(1).you.buildBudgetProtected,false);
  console.log('✓ 选址会话超时自动解除预算保护，不会永久阻止出兵');
}
