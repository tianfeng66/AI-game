'use strict';
const assert=require('node:assert/strict');
const {createGame,UnitType,Config}=require('./game');
function setup(type=UnitType.Warrior){
  const g=createGame();g.registerPlayer(1,'A');g.registerPlayer(2,'B');g.tick(.05);
  const a=g.units.find(u=>u.faction===1&&u.type===type),b=g.units.find(u=>u.faction===2&&u.type===UnitType.Warrior);
  g.units=[a,b];a.x=0;a.y=0;b.x=0;b.y=-1.5;a.thinkTimer=b.thinkTimer=1000;
  g.handleMessage(1,{type:'possess',unitId:a.id});g.handleMessage(2,{type:'possess',unitId:b.id});
  return {g,a,b};
}
function advance(g,seconds){for(let i=0;i<Math.ceil(seconds/.05);i++)g.tick(.05);}
function attack(g,aimX=0,aimY=-1){g.handleMessage(1,{type:'control',dx:0,dy:0,attack:true,aimX,aimY});g.tick(.05);}
{
  const {g,a}=setup();assert.equal(a.maxHp,180);assert.equal(a.hp,180);assert.equal(g.serializeFor(1).units.find(u=>u.id===a.id).attack,21.6);
  a.hp=90;g.handleMessage(1,{type:'release'});assert.equal(a.maxHp,150);assert.equal(a.hp,75);
  for(let i=0;i<20;i++){g.handleMessage(1,{type:'possess',unitId:a.id});assert.equal(a.maxHp,180);assert.equal(a.hp,90);g.handleMessage(1,{type:'release'});}
  assert.equal(a.hp,75);g.handleMessage(1,{type:'possess',unitId:a.id});
  g.factions[1].resources.gold=500;g.factions[1].resources.ore=100;g.handleMessage(1,{type:'upgrade'});
  assert.equal(a.maxHp,Math.round(150*1.15*1.2));g.handleMessage(1,{type:'release'});assert.equal(a.maxHp,Math.round(150*1.15));
  console.log('✓ 化身攻击和生命 +20%；退出保留生命比例，重复切换不叠加、不回血，升级后仍正确');
}
{
  const {g,a,b}=setup();const hp=b.hp;attack(g);assert.equal(b.hp,hp);assert.equal(a.attackSeq,1);
  advance(g,.25);assert.ok(Math.abs(b.hp-(hp-21.6))<1e-8);
  attack(g);assert.equal(a.attackSeq,1);
  console.log('✓ 近战先播放动作再结算伤害，冷却内重复按键不重复攻击');
}
{
  const {g,a,b}=setup();const hp=b.hp;attack(g,0,1);advance(g,.25);
  assert.equal(a.attackSeq,1);assert.equal(b.hp,hp);
  console.log('✓ 空挥有攻击动作，背后的敌人不会被自动命中');
}
{
  const {g,a,b}=setup(UnitType.Archer);b.y=-10;const hp=b.hp;
  attack(g);advance(g,.25);assert.equal(g.projectiles.length,0);assert.equal(b.hp,hp);
  advance(g,.2);assert.equal(g.projectiles.length,1);assert.equal(b.hp,hp);
  assert.equal(g.serializeFor(2).projectiles.length,1);advance(g,.45);
  assert.ok(Math.abs(b.hp-(hp-14.4))<1e-8);assert.equal(g.projectiles.length,0);
  console.log('✓ 射手拉弓后发箭，箭矢飞行后命中，动画状态和箭矢同步给其他玩家');
}
{
  const {g,b}=setup(UnitType.Archer);b.y=-8;const hp=b.hp;attack(g,1,0);advance(g,1.3);
  assert.equal(b.hp,hp);assert.equal(g.projectiles.length,0);
  console.log('✓ 箭矢遵循准心方向，射偏不命中旁边敌人，超出射程回收');
}
{
  const {g,a,b}=setup();g.handleMessage(1,{type:'release'});b.y=-8;
  g.handleMessage(2,{type:'order_attack',unitId:a.id,targetId:b.id,targetKind:'unit'});assert.equal(a.order,null);
  g.handleMessage(1,{type:'order_attack',unitId:a.id,targetId:a.id,targetKind:'unit'});assert.equal(a.order,null);
  g.handleMessage(1,{type:'order_attack',unitId:a.id,targetId:b.id,targetKind:'unit'});const hp=b.hp;advance(g,2);
  assert.ok(a.y<-3);assert.ok(b.hp<hp);assert.equal(g.serializeFor(1).units.find(u=>u.id===a.id).order.id,b.id);
  g.handleMessage(1,{type:'cancel_order',unitId:a.id});assert.equal(a.order,null);
  g.handleMessage(1,{type:'order_attack',unitId:a.id,targetId:b.id,targetKind:'unit'});g.handleMessage(1,{type:'possess',unitId:a.id});assert.equal(a.order,null);
  console.log('✓ 俯视攻击指令自动追击并攻击，支持取消；拒绝操控敌兵和攻击友军；化身会接管指令');
}
{
  const {g,a}=setup(UnitType.Archer);attack(g);g.handleMessage(1,{type:'release'});a.thinkTimer=1000;advance(g,.6);assert.equal(g.projectiles.length,0);
  g.handleMessage(1,{type:'possess',unitId:a.id});g.handleMessage(1,{type:'control',dx:Infinity,dy:NaN,aimX:Infinity,aimY:NaN});advance(g,.1);
  assert.ok(Number.isFinite(a.x)&&Number.isFinite(a.y)&&Number.isFinite(a.aimX));
  console.log('✓ 退出化身取消未释放攻击，非法瞄准或移动输入不会污染游戏状态');
}
