'use strict';
const assert=require('node:assert/strict');
const {createGame}=require('./game');
const World=require('../client/world');
function fixture(){
  const g=createGame();g.registerPlayer(1,'部队 A');g.registerPlayer(2,'部队 B');g.tick(.05);
  for(const b of g.bases)b.spawnTimer=1e6;
  for(const u of g.units){u.thinkTimer=1e6;u.moveX=u.moveY=0;}
  g.factions[1].resources.food=g.factions[2].resources.food=1000;
  return {g,own:g.units.filter(u=>u.faction===1),enemy:g.units.find(u=>u.faction===2),base:g.bases.find(b=>b.faction===1)};
}
function tick(g,seconds){for(let i=0;i<Math.round(seconds/.05);i++)g.tick(.05);}
{
  const {g,own,base}=fixture(),u=own[0];
  assert.equal(g.handleMessage(1,{type:'order_move',unitId:u.id,x:-29,y:17}).ok,true);
  const prior=u.order;
  const scenery=World.scenery(),tree=scenery.trees[0],rock=scenery.rocks.find(r=>r.solid);
  const blocked=[tree,rock,base,g.nodes[0],{x:49,y:0},{x:-24,y:-1},{x:20,y:-31.2}];
  g.towers.push({id:999,faction:1,x:-25,y:16});g.sites.push({id:998,faction:1,x:-25,y:20});
  blocked.push(g.towers[0],g.sites[0]);
  for(const p of blocked){assert.equal(g.handleMessage(1,{type:'order_move',unitId:u.id,x:p.x,y:p.y}).ok,false,JSON.stringify(p));assert.equal(u.order,prior);}
  assert.equal(World.movementError(-26,-22), ''); // open forest clearing remains selectable
  console.log('✓ 服务端拒绝树木、巨石、矿洞、风车、建筑、资源点与越界目的地，保留原指令；林间空地可选');
}
{
  const {g,own,enemy}=fixture(),u=own[0],hp=u.maxHp;
  assert.equal(g.handleMessage(1,{type:'take_control',unitIds:[u.id,enemy.id]}).count,1);
  assert.equal(u.possessed,false);assert.equal(u.maxHp,hp);assert.equal(u.commanded,true);
  const start=[u.x,u.y];tick(g,1);assert.deepEqual([u.x,u.y],start);
  for(const x of [NaN,Infinity,100,'0'])assert.equal(g.handleMessage(1,{type:'order_move',unitId:u.id,x,y:0}).ok,false);
  g.handleMessage(1,{type:'order_move',unitId:u.id,x:u.x+4,y:u.y+2});tick(g,.3);
  const target={x:u.x-2,y:u.y-3};g.handleMessage(1,{type:'order_move',unitId:u.id,...target});tick(g,2);
  assert.equal(u.x,target.x);assert.equal(u.y,target.y);assert.equal(u.order,null);
  tick(g,2);assert.equal(u.x,target.x);assert.equal(u.y,target.y);assert.equal(u.commanded,true);
  g.handleMessage(1,{type:'cancel_order',unitId:u.id});tick(g,.3);assert.equal(u.commanded,false);
  assert.ok(u.x!==target.x||u.y!==target.y);
  console.log('✓ 单击接管保持俯视与原生命值；点击移动可中途改目的地，精确抵达后持续待命；X 恢复 AI，拒绝无效坐标');
}
{
  const {g,own}=fixture(),u=own[0];
  g.handleMessage(1,{type:'build_tower',x:-26,y:17});assert.ok(u.buildSiteId);
  g.handleMessage(1,{type:'take_control',unitId:u.id});tick(g,.5);
  assert.equal(u.buildSiteId,null);assert.equal(g.sites[0].workerId,null);
  g.handleMessage(1,{type:'cancel_build',siteId:g.sites[0].id});
  assert.equal(g.handleMessage(1,{type:'build_tower',x:-26,y:17,workerId:u.id}).ok,true);
  assert.equal(u.commanded,false);assert.ok(u.buildSiteId);
  console.log('✓ 接管工人后工地不会自动抢回控制；主动建造仍可派遣已接管工人');
}
{
  const {g,own,enemy,base}=fixture();const types=own.map(u=>u.type);
  const ids=[...own.map(u=>u.id),own[0].id,enemy.id,99999];
  const attacked=g.handleMessage(1,{type:'order_attack',unitIds:ids,targetKind:'unit',targetId:enemy.id});
  assert.equal(attacked.count,3);assert.ok(own.every(u=>u.order.id===enemy.id));assert.equal(enemy.order,null);
  own.forEach((u,i)=>{u.x=base.x+10;u.y=base.y+i;});own[0].carried.gold=5;
  const gold=g.factions[1].resources.gold;
  const home=g.handleMessage(1,{type:'order_home',unitIds:ids});assert.equal(home.count,3);
  assert.ok(own.every(u=>u.order.kind==='home'&&!u.pendingAttack));
  let arrived=false;
  for(let i=0;i<100;i++){g.tick(.05);if(own.every(u=>!u.order)){arrived=true;break;}}
  assert.ok(arrived);assert.ok(own.every(u=>Math.hypot(u.x-base.x,u.y-base.y)<=2.5));
  assert.deepEqual(own.map(u=>u.type),types);assert.equal(own[0].carried.gold,0);assert.equal(g.factions[1].resources.gold,gold+5);
  assert.ok(own.every(u=>!u.commanded));
  tick(g,.3);assert.ok(own.some(u=>Math.abs(u.moveX)+Math.abs(u.moveY)>0));assert.ok(own.every(u=>!u.order));
  console.log('✓ 多单位集中攻击，回家替换攻击指令，到达后上缴资源并恢复各兵种 AI；过滤敌人、无效和重复 ID');
}
{
  const {g,own,base}=fixture();const second={...base,id:900,x:-10,y:15};g.bases.push(second);
  own[0].x=-12;own[0].y=15;g.handleMessage(1,{type:'order_home',unitIds:[own[0].id]});assert.equal(own[0].order.id,900);
  second.faction=2;tick(g,.05);assert.equal(own[0].order.id,base.id);
  g.bases=g.bases.filter(b=>b.faction!==1);tick(g,.25);assert.equal(own[0].order,null);
  assert.equal(g.handleMessage(1,{type:'order_home',unitIds:[own[1].id]}).ok,false);
  console.log('✓ 返回最近己方基地，基地失守后重新选择，全部失去时安全解除指令');
}
{
  const {g,own,enemy}=fixture();g.handleMessage(1,{type:'possess',unitId:own[1].id});
  const result=g.handleMessage(1,{type:'order_home',unitIds:own.map(u=>u.id)});assert.equal(result.count,2);assert.equal(own[1].order,null);
  g.handleMessage(1,{type:'cancel_order',unitIds:own.map(u=>u.id)});assert.ok(own.every(u=>!u.order));
  g.handleMessage(1,{type:'release'});
  g.handleMessage(1,{type:'build_tower',x:-26,y:17});assert.ok(own[0].buildSiteId);
  g.handleMessage(1,{type:'order_home',unitIds:[own[0].id]});assert.equal(own[0].buildSiteId,null);assert.equal(own[0].order.kind,'home');
  assert.equal(g.handleMessage(2,{type:'order_home',unitIds:[own[0].id]}).count,0);assert.equal(enemy.order,null);
  console.log('✓ 化身单位不受批量 AI 指令覆盖；可批量取消，工人回家会交接施工，敌方不能操控己方部队');
}
