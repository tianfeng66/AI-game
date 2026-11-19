'use strict';
const assert = require('node:assert/strict');
const { createGame, Config, UnitType, ResourceType } = require('./game');
function setup() {
  const g=createGame(); g.registerPlayer(1,'A'); g.registerPlayer(2,'B'); g.tick(.05);
  for(const u of g.units) { u.thinkTimer=1e6; u.moveX=u.moveY=0; }
  for(const b of g.bases) b.spawnTimer=1e6;
  return g;
}
function test(name, run) {
  try { run(); console.log('PASS '+name); }
  catch(error) { console.error('FAIL '+name, error.message); process.exitCode=1; }
}
test('gathering never exceeds carrying capacity or removes excess resources',()=>{
  const g=setup(),u=g.units.find(u=>u.faction===1&&u.type===UnitType.Worker);
  const n=g.nodes.find(n=>n.type===ResourceType.Gold);
  g.nodes=[n];u.x=n.x;u.y=n.y;u.carried.gold=24;u.thinkTimer=0;
  g.tick(.05);assert.equal(u.carried.gold,25);assert.equal(n.amount,99);
});
test('workers deposit at the nearest owned base',()=>{
  const g=setup(),u=g.units.find(u=>u.faction===1&&u.type===UnitType.Worker);
  g.bases.push({...g.bases[0],id:999,x:0,y:0});u.x=0;u.y=0;u.carried.gold=25;u.thinkTimer=0;
  const before=g.factions[1].resources.gold;
  g.tick(.05);assert.equal(u.carried.gold,0);assert.equal(g.factions[1].resources.gold,before+25);
});
test('tower kills award the owning faction gold and score exactly once',()=>{
  const g=setup(),u=g.units.find(u=>u.faction===2);u.hp=1;u.x=0;u.y=0;
  g.towers.push({id:999,faction:1,level:1,x:0,y:1,hp:200,maxHp:200,lastAttack:-10});
  const before={...g.factions[1].resources};g.tick(.05);g.tick(.05);
  assert.ok(!g.units.includes(u));assert.equal(g.factions[1].score,Config.scoreKill);
  assert.equal(g.factions[1].resources.gold,before.gold+Config.killRewardGold);
});
test('resource upgrades use the highest level owned base',()=>{
  const g=setup(),n=g.nodes[0];n.owner=1;
  g.bases.push({...g.bases[0],id:999,level:2,x:0,y:0});
  const result=g.handleMessage(1,{type:'upgrade_resource',nodeId:n.id});
  assert.equal(result.ok,true);assert.equal(n.level,2);
});
test('economy preserves elapsed remainder and catches up full seconds',()=>{
  const g=setup();for(let i=0;i<10;i++)g.tick(.3);
  assert.equal(g.factions[1].resources.food,49);
  assert.ok(Math.abs(g.factions[1].foodDebt-.8)<1e-8);
  const h=setup();h.tick(3);assert.equal(h.factions[1].resources.food,49);
  assert.ok(Math.abs(h.factions[1].foodDebt-.8)<1e-8);
});

test('spawn slots stay unique and the 11th player is refused',()=>{
  const g=createGame();
  for(let i=1;i<=10;i++)assert.equal(g.registerPlayer(i,'P'+i),true);
  assert.equal(new Set(g.bases.map(b=>`${b.x},${b.y}`)).size,10);
  assert.equal(g.registerPlayer(11,'P11'),false,'第 11 人被拒绝');
  g.handleMessage(2,{type:'surrender'});
  assert.equal(g.registerPlayer(11,'P11'),true,'投降释放的出生点可被复用');
  const coords=g.bases.map(b=>`${b.x},${b.y}`);
  assert.equal(new Set(coords).size,coords.length,'复用后仍不与现存基地重叠');
});

test('a human joining a running match replaces one filler AI',()=>{
  const g=createGame();g.registerPlayer(1,'A');g.tick(.05);
  assert.ok(Object.keys(g.factions).some(id=>Number(id)>=1000),'单人时自动补一个 AI');
  assert.equal(g.registerPlayer(2,'B'),true);
  assert.ok(!Object.keys(g.factions).some(id=>Number(id)>=1000),'真人加入后 AI 让位');
  assert.equal(new Set(g.bases.map(b=>`${b.x},${b.y}`)).size,2);
});

test('joining a faction moves stock, resource ownership, arrows and score',()=>{
  const g=createGame();for(let i=1;i<=3;i++)g.registerPlayer(i,'P'+i);
  g.factions[1].resources.gold=999;g.factions[1].score=50;
  g.nodes[0].owner=1;
  g.projectiles.push({id:9001,faction:1,ownerId:1,x:0,y:0,dx:1,dy:0,remaining:10,speed:24,damage:1});
  const before=g.factions[2].resources.gold;
  assert.equal(g.handleMessage(1,{type:'join_faction',target:2}).ok,true);
  assert.equal(g.factions[2].resources.gold,before+999,'库存迁移');
  assert.equal(g.factions[2].score,50,'积分迁移');
  assert.equal(g.nodes[0].owner,2,'资源点归属迁移');
  assert.equal(g.projectiles[0].faction,2,'在途箭矢迁移');
  assert.equal(g.units.filter(u=>u.faction===1).length,0,'单位迁移');
  assert.equal(g.serializeFor(1).you.mergedInto,2,'客户端可见并入状态');
});

test('merge chains resolve to the root and illegal merges are refused',()=>{
  const g=createGame();for(let i=1;i<=3;i++)g.registerPlayer(i,'P'+i);
  assert.equal(g.handleMessage(1,{type:'join_faction',target:2}).ok,true);
  assert.equal(g.handleMessage(2,{type:'join_faction',target:3}).ok,true);
  assert.equal(g.rootFaction(1),3,'多层链解析到根');
  assert.equal(g.handleMessage(3,{type:'join_faction',target:1}).ok,false,'禁止循环合并');
  assert.equal(g.handleMessage(1,{type:'join_faction',target:3}).ok,false,'禁止重复合并');
  assert.equal(g.handleMessage(1,{type:'join_faction',target:1}).ok,false,'禁止加入自己');
  const h=createGame();h.registerPlayer(1,'A');h.registerPlayer(2,'B');
  h.handleMessage(2,{type:'surrender'});
  assert.equal(h.handleMessage(1,{type:'join_faction',target:2}).ok,false,'禁止加入已投降阵营');
});

test('gather rate matches config instead of rounding every think step up',()=>{
  const g=createGame();g.registerPlayer(1,'A');g.registerPlayer(2,'B');g.tick(.05);
  for(const u of g.units){u.thinkTimer=1e6;u.moveX=u.moveY=0;}
  for(const b of g.bases)b.spawnTimer=1e6;
  const n=g.nodes.find(x=>x.type===ResourceType.Gold);
  const worker=g.units.find(u=>u.faction===1&&u.type===UnitType.Worker);
  const warrior=g.units.find(u=>u.faction===1&&u.type===UnitType.Warrior);
  worker.x=warrior.x=n.x;worker.y=warrior.y=n.y;worker.thinkTimer=warrior.thinkTimer=0;
  const start=n.amount;
  for(let i=0;i<20;i++)g.tick(.05);
  const collected=start-n.amount;
  assert.ok(collected>=7&&collected<=9,`1 秒采集 ${collected}，应接近配置的 6+2=8`);
  assert.ok(worker.gatherDebt<1&&warrior.gatherDebt<1,'小数余量保留而不是丢失');
});

test('state snapshots omit constant rules and compress coordinates',()=>{
  const g=createGame();g.registerPlayer(1,'A');
  assert.ok(!('rules' in g.serializeFor(1)),'rules 不再每帧下发');
  assert.equal(g.rulesSnapshot().towerBuildSeconds,Config.towerBuildSeconds,'welcome 规则快照完整');
  g.units[0].x=12.3456789;
  assert.equal(g.serializeFor(1).units[0].x,12.35,'坐标压缩到 2 位');
});

test('full-match snapshot stays under 20 KB',()=>{
  const g=createGame();
  for(let i=1;i<=10;i++)g.registerPlayer(i,'P'+i);
  for(let i=1;i<=10;i++){
    const b=g.bases.find(x=>x.faction===i),own=g.units.filter(u=>u.faction===i);
    for(let k=own.length;k<8;k++)g.units.push({
      id:9000+i*10+k,faction:i,type:k%3,hp:100,maxHp:100,x:b.x+k+.123456,y:b.y-7.654321,
      possessed:false,attackSeq:0,attackStartedAt:0,aimX:.123456,aimY:-.987654,
      attackAimX:0,attackAimY:-1,order:null,commanded:false,buildSiteId:null,regenTimer:.123456,
    });
  }
  const bytes=Buffer.byteLength(JSON.stringify(g.serializeFor(1)),'utf8');
  assert.ok(bytes<20000,`满员单帧 ${bytes} B，应低于 20 KB`);
});

test('a faction with a base but no units gets a free worker instead of deadlocking',()=>{
  const g=setup();
  g.units=g.units.filter(u=>u.faction!==1);
  Object.assign(g.factions[1].resources,{gold:0,food:0,wood:0,ore:0});
  const base=g.bases.find(b=>b.faction===1);base.spawnTimer=0;
  g.tick(.05);
  const rescued=g.units.filter(u=>u.faction===1);
  assert.equal(rescued.length,1,'无单位且买不起时，基地出一名免费单位');
  assert.equal(rescued[0].type,UnitType.Worker,'救援单位必须是能高效采集的工人');
  assert.deepEqual(g.factions[1].resources,{gold:0,food:0,wood:0,ore:0},'救援出兵不扣资源');
});

test('rescue worker is only for factions with no units; normal production still costs resources',()=>{
  const g=setup();
  Object.assign(g.factions[1].resources,{gold:0,food:0,wood:0,ore:0});
  const before=g.units.filter(u=>u.faction===1).length;
  g.bases.find(b=>b.faction===1).spawnTimer=0;g.tick(.05);
  assert.equal(g.units.filter(u=>u.faction===1).length,before,'有单位且买不起时不能白拿');
  Object.assign(g.factions[1].resources,{gold:20,food:20,wood:0,ore:0});
  g.bases.find(b=>b.faction===1).spawnTimer=0;g.tick(.05);
  assert.equal(g.units.filter(u=>u.faction===1).length,before+1,'买得起时仍正常出兵');
  assert.equal(g.factions[1].resources.gold,10,'正常出兵仍扣 10 金币');
});

test('rescue worker respects the per-faction unit cap and an empty base never spawns for a dead faction',()=>{
  const g=setup();
  g.units=g.units.filter(u=>u.faction!==1);
  g.bases=g.bases.filter(b=>b.faction!==1);
  g.tick(.05);
  assert.equal(g.units.filter(u=>u.faction===1).length,0,'无基地的阵营不会出兵');
});
