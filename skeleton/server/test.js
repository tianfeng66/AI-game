'use strict';
// 自测：模拟对局，验证采集/生产/化身/升级/建造/投降/胜负判定
const { createGame, Config, ResourceType, UnitType } = require('./game');

// Fix the RNG so the 60-second simulation is reproducible; production code is untouched.
let seed = 20261108;
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

const game = createGame();
game.registerPlayer(1, 'P1');
game.registerPlayer(2, 'P2');

// 模拟 60 秒（20 tick/秒）
const dt = 1 / 20;
for (let i = 0; i < 1200; i++) game.tick(dt);

console.log('== 60 秒后 ==');
console.log('状态:', game.state, '| 剩余:', Math.ceil(game.timeLeft) + 's');
console.log('单位数:', game.units.length, '| 基地数:', game.bases.length);
for (const fid of [1, 2]) {
  const f = game.factions[fid];
  console.log(`  阵营${fid} ${f.name}: 金${f.resources.gold} 粮${f.resources.food} 木${f.resources.wood} 矿${f.resources.ore} 分${f.score} Lv${f.upgradeLevel} 单位${game.units.filter(u=>u.faction===fid).length}`);
}

assert(game.state === 'running', '对局仍在进行（未意外结束）');
assert(game.units.length >= 4, '基地已生产出单位（经济闭环成立）');
assert(game.factions[1].resources.gold >= 0 && game.factions[2].resources.gold >= 0, '资源非负');

// 指令与胜负验证放在独立短局里，不依赖 60 秒随机战况中谁还剩单位
const ops = createGame();
ops.registerPlayer(1, 'P1');
ops.registerPlayer(2, 'P2');
ops.tick(dt);

// 化身切换
ops.handleMessage(1, { type: 'possess_switch' });
const possessed = ops.units.find(u => u.possessed && u.faction === 1);
assert(!!possessed, 'P 键化身切换生效');

// 化身控制
ops.handleMessage(1, { type: 'control', dx: 1, dy: 0, attack: false });
assert(possessed.moveX === 1 && possessed.moveY === 0, '化身后 WASD 控制生效');

// 升级（先给足资源）
ops.factions[1].resources.gold = 500;
ops.factions[1].resources.ore = 100;
const lvBefore = ops.factions[1].upgradeLevel;
ops.handleMessage(1, { type: 'upgrade' });
assert(ops.factions[1].upgradeLevel === lvBefore + 1, 'U 键阵营升级生效');

// 建造箭塔：释放化身后才有可用工人
ops.handleMessage(1, { type: 'release' });
ops.factions[1].resources.wood = 100;
const towersBefore = ops.towers.length;
const buildResult = ops.handleMessage(1, { type: 'build_tower', x: -26, y: 17 });
assert(buildResult.ok && ops.sites.length === 1 && ops.towers.length === towersBefore, '建塔先创建工地并派遣工人，不会瞬间完成');

// 投降 → 只剩阵营 1，判胜
ops.handleMessage(2, { type: 'surrender' });
for (let i = 0; i < 5; i++) ops.tick(dt);
assert(ops.state === 'over', '投降后触发胜负判定');
assert(/1/.test(ops.resultText), '剩余阵营 1 获胜：' + ops.resultText);

// Regression checks for the shared 3D map and possession lifecycle.
const World = require('../client/world');
const mapGame = createGame();
mapGame.registerPlayer(1, '地图测试');
mapGame.tick(dt);
assert(mapGame.nodes.length === World.regions.length * 3, '地图的八个资源区与服务器采集点一一对应');
assert(mapGame.nodes.every(n => World.regions.some(r => r.type === n.type && Math.hypot(n.x-r.x,n.y-r.y) < r.radius)), '矿石、粮食和木材都在对应地貌内');
assert(Math.hypot(mapGame.bases[0].x-mapGame.bases[1].x,mapGame.bases[0].y-mapGame.bases[1].y)>40, '双方基地保持安全的开局距离');
const worker = mapGame.units.find(u=>u.faction===1 && u.type===UnitType.Worker);
const base = mapGame.bases.find(b=>b.faction===1);
worker.x=base.x;worker.y=base.y;worker.thinkTimer=0;
worker.carried={gold:10,food:10,wood:10,ore:10};
const beforeResources={...mapGame.factions[1].resources};
mapGame.tick(dt);
assert(['gold','food','wood','ore'].every(k=>mapGame.factions[1].resources[k]===beforeResources[k]+10), '采集上缴正确计入四类资源，而不是未使用的数字字段');
mapGame.handleMessage(1,{type:'possess',unitId:worker.id});
mapGame.handleMessage(1,{type:'control',dx:1,dy:0,attack:true});
mapGame.handleMessage(1,{type:'release'});
assert(!worker.possessed && worker.moveX===0 && !worker.wantAttack, 'Esc 退出化身立即清除移动和攻击状态');
assert(mapGame.serializeFor(1).you.possessedUnitId===null, '退出化身同步到客户端，触发俯视镜头');
mapGame.tick(dt);
assert(worker.thinkTimer>0, '退出化身后恢复 AI 思考与自动采集');
mapGame.handleMessage(1000,{type:'possess',unitId:worker.id});
assert(!worker.possessed, '不能通过化身消息控制敌方单位');
mapGame.handleMessage(1,{type:'possess',unitId:worker.id});
worker.x=Config.mapHalf;worker.y=0;
mapGame.handleMessage(1,{type:'control',dx:1,dy:0,attack:false});mapGame.tick(dt);
assert(worker.x===Config.mapHalf, '化身移动受地图边界约束');

console.log('\n自测完成' + (process.exitCode ? '（有失败）' : '（全部通过）'));
