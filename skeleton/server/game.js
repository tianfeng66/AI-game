'use strict';

// ============================================================
// 火柴人领地 —— 服务端游戏逻辑（纯 Node，无网络依赖，可单测）
// 对应原 Unity 骨架的 GameManager/Unit/AIBrain/BaseBuilding/ArrowTower
// ============================================================

const ResourceType = { Gold: 0, Food: 1, Wood: 2, Ore: 3 };
const UnitType = { Worker: 0, Warrior: 1, Archer: 2 };
const World = require('../client/world');

const Config = {
  matchSeconds: 600,
  gatherRange: 1.5,
  aiThinkInterval: 0.2,
  unitStats: {
    [UnitType.Worker]:  { maxHp: 80,  attack: 5,  speed: 4.0, carry: 25, gather: 6, range: 1.5, sight: 8,  attackSpeed: 0.8 },
    [UnitType.Warrior]: { maxHp: 150, attack: 18, speed: 5.0, carry: 5,  gather: 2, range: 1.5, sight: 10, attackSpeed: 0.8 },
    [UnitType.Archer]:  { maxHp: 70,  attack: 12, speed: 4.5, carry: 8,  gather: 2, range: 18, sight: 22, attackSpeed: 1.2 },
  },
  possessBuffAttack: 1.2,
  possessBuffHp: 1.2,
  possessBuffSpeed: 1.15,
  baseMaxHp: 500,
  baseSpawnInterval: 8,
  maxUnitsPerFaction: 8,
  unitSpawnCostGold: 10,
  unitSpawnCostFood: 5,
  upkeepFoodPerUnitPerSecond: 0.2,
  starvationDamagePerTick: 5,
  upgradeBaseCostGold: 50,
  upgradeOreCost: 20,
  maxUpgradeLevel: 5,
  upgradeAttackBonus: 0.15,
  upgradeHpBonus: 0.15,
  towerCostWood: 30,
  towerCostGold: 15,
  towerBuildSeconds: 12,
  buildRange: 1.8,
  regenerationSeconds: 10,
  regenerationFraction: .01,
  scoreKill: 10,
  scorePossessedKill: 30,
  killRewardGold: 2,
  scoreBaseCapture: 100,
  scoreTowerDestroy: 15,
  towerHp: 200,
  towerAttack: 15,
  towerRange: 6,
  towerAttackSpeed: 1,
  towerMaxLevel: 5,
  towerUpgradeCostGold: 10,
  towerUpgradeCostWood: 20,
  towerUpgradeAttackBonus: 0.25,
  towerUpgradeHpBonus: 0.25,
  towerUpgradeRangeBonus: 0.5,
  baseMaxLevel: 5,
  baseUpgradeCostGold: 30,
  baseUpgradeCostOre: 15,
  baseUpgradeHpBonus: 0.25,
  baseSpawnSpeedBonus: 0.12,
  resourceMaxLevel: 5,
  resourceUpgradeCostGold: 8,
  resourceUpgradeCostWood: 10,
  resourceYieldBonus: 0.25,
  mapHalf: World.half,
};

// Full float coordinates dominate the 20 Hz snapshot; 0.01 world units is far
// below both the renderer's resolution and any gameplay threshold.
const r2 = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : n;

function createGame() {
  let nextId = 1;

  const game = {
    units: [],
    bases: [],
    towers: [],
    sites: [],
    nodes: [],
    projectiles: [],
    factions: {},    // factionId -> {name, resources, score, upgradeLevel, surrendered, joinedFactionId}
    players: {},     // factionId -> {factionId, name}  (真人)
    state: 'waiting', // waiting / running / over
    timeLeft: Config.matchSeconds,
    resultText: '',
    time: 0,
    economyTimer: 1,
  };

  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  function addFaction(factionId, name) {
    game.factions[factionId] = {
      name,
      resources: { gold: 30, food: 50, wood: 30, ore: 20 }, // 起始资源，避免开局饿死
      score: 0,
      upgradeLevel: 1,
      surrendered: false,
      joinedFactionId: -1,
      foodDebt: 0,
      buildPreviewUntil: 0,
    };
    return game.factions[factionId];
  }

  function baseMaxHpValue(b) { return Math.round(Config.baseMaxHp * (1 + ((b.level || 1) - 1) * Config.baseUpgradeHpBonus)); }
  function baseSpawnIntervalValue(b) { return Config.baseSpawnInterval * (1 - ((b.level || 1) - 1) * Config.baseSpawnSpeedBonus); }

  // A spawn slot is reserved by index, so surrendered bases cannot make a later
  // player reuse an occupied position (the old `bases.length % 10` did exactly that).
  function freeSpawnIndex() {
    const used = new Set(game.bases.map(b => b.spawnIndex).filter(i => Number.isInteger(i)));
    for (let i = 0; i < World.spawns.length; i++) if (!used.has(i)) return i;
    return -1;
  }

  function spawnBase(factionId) {
    const spawnIndex = freeSpawnIndex();
    if (spawnIndex < 0) return null;
    const position = World.spawns[spawnIndex];
    const b = {
      id: nextId++,
      faction: factionId,
      level: 1,
      hp: Config.baseMaxHp,
      maxHp: Config.baseMaxHp,
      x: position[0],
      y: position[1],
      spawnIndex,
      spawnTimer: Config.baseSpawnInterval,
    };
    game.bases.push(b);
    return b;
  }

  function upgradeLevel(factionId) {
    const f = game.factions[factionId];
    return f ? f.upgradeLevel : 1;
  }
  function attackMult(factionId) { return 1 + (upgradeLevel(factionId) - 1) * Config.upgradeAttackBonus; }
  function safeAttack(u) { return Number((Config.unitStats[u.type].attack*attackMult(u.faction)*(u.possessed?Config.possessBuffAttack:1)).toFixed(2)); }
  function hpMult(factionId) { return 1 + (upgradeLevel(factionId) - 1) * Config.upgradeHpBonus; }

  function spawnUnit(factionId, type, x, y) {
    const s = Config.unitStats[type];
    const maxHp = Math.round(s.maxHp * hpMult(factionId));
    const u = {
      id: nextId++,
      faction: factionId,
      type,
      hp: maxHp,
      maxHp,
      x, y,
      moveX: 0, moveY: 0,
      wantAttack: false,
      possessed: false, commanded: false,
      carried: { gold: 0, food: 0, wood: 0, ore: 0 },
      lastAttack: -10,
      attackSeq: 0, attackStartedAt: -10, attackAimX: 0, attackAimY: -1,
      aimX: 0, aimY: -1, pendingAttack: null, order: null,
      regenTimer: 0, buildSiteId: null,
      gatherDebt: 0, lastThinkAt: null, thinkElapsed: Config.aiThinkInterval,
      thinkTimer: Math.random() * Config.aiThinkInterval,
    };
    game.units.push(u);
    return u;
  }

  function spawnTower(factionId, x, y) {
    const t = { id: nextId++, faction: factionId, level: 1, hp: Config.towerHp, maxHp: Config.towerHp, x, y, lastAttack: 0 };
    game.towers.push(t);
    return t;
  }

  function nodeYieldValue(n) { return 1 + ((n.level || 1) - 1) * Config.resourceYieldBonus; }
  function nodeMaxAmountValue(n) { return Math.round(100 * (1 + ((n.level || 1) - 1) * Config.resourceYieldBonus)); }

  function spawnNode(type, x, y) {
    const n = { id: nextId++, type, level: 1, owner: -1, amount: 100, maxAmount: 100, x, y, respawnTimer: 0 };
    game.nodes.push(n);
    return n;
  }

  function initMap() {
    for (const r of World.regions) for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3;
      spawnNode(r.type, r.x + Math.cos(a) * 3, r.y + Math.sin(a) * 3);
    }
  }

  // ---------- 资源 ----------
  function getResource(factionId, type) { const f = game.factions[factionId]; return f ? f.resources[type] : 0; }
  function addResource(factionId, type, amount) { const f = game.factions[factionId]; if (f) f.resources[type] += amount; }
  function deposit(factionId, g, f2, w, o) {
    addResource(factionId, 'gold', g);
    addResource(factionId, 'food', f2);
    addResource(factionId, 'wood', w);
    addResource(factionId, 'ore', o);
  }
  function trySpend(factionId, gold, food, wood, ore, commitBuild = false) {
    const f = game.factions[factionId];
    if (!f) return false;
    // Preview protects the budget against automatic production, without deducting it.
    const protectedBudget=!commitBuild && f.buildPreviewUntil>game.time;
    if(protectedBudget && (f.resources.gold-gold<Config.towerCostGold || f.resources.wood-wood<Config.towerCostWood))return false;
    if (f.resources.gold < gold || f.resources.food < food || f.resources.wood < wood || f.resources.ore < ore) return false;
    f.resources.gold -= gold; f.resources.food -= food; f.resources.wood -= wood; f.resources.ore -= ore;
    return true;
  }
  function addScore(factionId, s) { const f = game.factions[factionId]; if (f) f.score += s; }

  // ---------- 查询 ----------
  function unitsOfFaction(factionId) { return game.units.filter(u => u.faction === factionId); }
  function getBaseOfFaction(factionId) { return game.bases.find(b => b.faction === factionId) || null; }
  function possessedUnitOf(factionId) { return game.units.find(u => u.possessed && u.faction === factionId) || null; }

  function findNearestEnemyUnit(x, y, faction, range) {
    let best = null, bestD = range;
    for (const u of game.units) {
      if (u.faction === faction) continue;
      const d = dist(x, y, u.x, u.y);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }
  function findNearestEnemyBase(x, y, faction, range) {
    let best = null, bestD = range;
    for (const b of game.bases) {
      if (b.faction === faction) continue;
      const d = dist(x, y, b.x, b.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }
  function findNearestEnemyTower(x, y, faction, range) {
    let best = null, bestD = range;
    for (const t of game.towers) {
      if (t.faction === faction) continue;
      const d = dist(x, y, t.x, t.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }
  function findNearestNode(x, y) {
    let best = null, bestD = Infinity;
    for (const n of game.nodes) {
      if (n.amount <= 0) continue;
      const d = dist(x, y, n.x, n.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }
  function findNearestNodeOfType(x, y, type) {
    let best = null, bestD = Infinity;
    for (const n of game.nodes) {
      if (n.type !== type || n.amount <= 0) continue;
      const d = dist(x, y, n.x, n.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // ---------- 阵营 ----------
  // When a human joins a running match, a filler AI steps aside so that "AI only
  // fills missing players" stays true and a 2-player match does not become 3-way.
  function releaseOneAiFaction() {
    const fid = Object.keys(game.factions).map(Number)
      .find(id => id >= 1000 && !game.players[id] && !game.factions[id].surrendered && game.factions[id].joinedFactionId <= 0);
    if (fid == null) return false;
    for (const list of [game.units, game.bases, game.towers, game.sites, game.projectiles]) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].faction === fid) list.splice(i, 1);
    }
    for (const n of game.nodes) if (n.owner === fid) n.owner = -1;
    delete game.factions[fid];
    return true;
  }

  function registerPlayer(factionId, name) {
    if (game.factions[factionId]) return false;
    if (game.state === 'running') releaseOneAiFaction();
    if (freeSpawnIndex() < 0) return false;
    addFaction(factionId, name);
    game.players[factionId] = { factionId, name };
    const b = spawnBase(factionId);
    spawnUnit(factionId, UnitType.Worker, b.x + 3, b.y);
    spawnUnit(factionId, UnitType.Warrior, b.x + 3, b.y + 2);
    spawnUnit(factionId, UnitType.Archer, b.x + 3, b.y - 2);
    return true;
  }

  function addAiFaction() {
    if (freeSpawnIndex() < 0) return null;
    let fid = 1000;
    while (game.factions[fid]) fid++;
    addFaction(fid, 'AI' + (fid - 1000));
    const b = spawnBase(fid);
    if (!b) { delete game.factions[fid]; return null; }
    spawnUnit(fid, UnitType.Worker, b.x + 3, b.y);
    spawnUnit(fid, UnitType.Warrior, b.x + 3, b.y + 2);
    spawnUnit(fid, UnitType.Archer, b.x + 3, b.y - 2);
    return fid;
  }

  function ensureMinPlayers() {
    const humanCount = Object.keys(game.players).length;
    if (humanCount < 2) {
      const need = 2 - humanCount;
      for (let i = 0; i < need; i++) addAiFaction();
    }
  }

  // ---------- 采集 ----------
  function carriedTotal(u) { return u.carried.gold + u.carried.food + u.carried.wood + u.carried.ore; }

  function gather(u, node) {
    if (node.owner == null || node.owner === -1) node.owner = u.faction;
    const s = Config.unitStats[u.type];
    const capacity = Math.max(0, s.carry - carriedTotal(u));
    // Carry the fractional remainder instead of rounding every think step up:
    // ceil(6 * 0.2) = 2 used to turn a 6/s worker into 10/s and a 2/s warrior into 5/s.
    const elapsed = u.thinkElapsed || Config.aiThinkInterval;
    const debt = Math.min((u.gatherDebt || 0) + s.gather * elapsed * nodeYieldValue(node), s.carry);
    const got = Math.min(Math.floor(debt), node.amount, capacity);
    u.gatherDebt = debt - got;
    node.amount -= got;
    if (node.amount <= 0) node.respawnTimer = 30;
    if (got <= 0) return;
    if (node.type === ResourceType.Gold) u.carried.gold += got;
    else if (node.type === ResourceType.Food) u.carried.food += got;
    else if (node.type === ResourceType.Wood) u.carried.wood += got;
    else u.carried.ore += got;
  }

  function doDeposit(u) {
    deposit(u.faction, u.carried.gold, u.carried.food, u.carried.wood, u.carried.ore);
    u.carried.gold = u.carried.food = u.carried.wood = u.carried.ore = 0;
  }

  // ---------- AI ----------
  function aiThink(u, dt) {
    if (u.possessed) return;
    u.thinkTimer -= dt;
    // 0.2 - 4 * 0.05 leaves a ~1e-17 residue; comparing against 0 silently
    // stretched the think interval to 0.25 s and skewed every rate built on it.
    if (u.thinkTimer > 1e-8) return;
    u.thinkTimer = Config.aiThinkInterval;
    decide(u);
  }

  function decide(u) {
    const last = u.lastThinkAt;
    u.lastThinkAt = game.time;
    u.thinkElapsed = last == null ? Config.aiThinkInterval : Math.min(Math.max(0, game.time - last), 0.5);
    const s = Config.unitStats[u.type];
    u.wantAttack = false;
    if (u.buildSiteId != null) {
      const site=game.sites.find(b=>b.id===u.buildSiteId && b.faction===u.faction);
      if(site){
        const d=dist(u.x,u.y,site.x,site.y);
        u.moveX=d>Config.buildRange?(site.x-u.x)/d:0;u.moveY=d>Config.buildRange?(site.y-u.y)/d:0;
        u.aimX=(site.x-u.x)/(d||1);u.aimY=(site.y-u.y)/(d||1);return;
      }
      u.buildSiteId=null;
    }
    if (u.order) {
      if(u.order.kind==='move'){
        const d=dist(u.x,u.y,u.order.x,u.order.y);
        u.moveX=d?(u.order.x-u.x)/d:0;u.moveY=d?(u.order.y-u.y)/d:0;return;
      }
      if(u.order.kind==='home'){
        let base=game.bases.find(b=>b.id===u.order.id&&b.faction===u.faction);
        if(!base)base=game.bases.filter(b=>b.faction===u.faction).sort((a,b)=>dist(u.x,u.y,a.x,a.y)-dist(u.x,u.y,b.x,b.y))[0];
        if(base){
          u.order.id=base.id;
          const d=dist(u.x,u.y,base.x,base.y);
          if(d>2.5){u.moveX=(base.x-u.x)/d;u.moveY=(base.y-u.y)/d;return;}
          if(carriedTotal(u)>0)doDeposit(u);
        }
        u.order=null;u.commanded=false;u.moveX=u.moveY=0;u.pendingAttack=null;return;
      }
      const target = combatTarget(u.order.kind, u.order.id);
      if (target && target.faction !== u.faction && target.hp > 0) {
        chaseOrAttack(u, target.x, target.y, s); return;
      }
      u.order = null;
    }
    if(u.commanded){u.moveX=u.moveY=0;return;}
    if (u.type === UnitType.Warrior) {
      const e = findNearestEnemyUnit(u.x, u.y, u.faction, s.sight);
      if (e) { chaseOrAttack(u, e.x, e.y, s); return; }
      const eb = findNearestEnemyBase(u.x, u.y, u.faction, s.sight);
      if (eb) { chaseOrAttack(u, eb.x, eb.y, s); return; }
      if (carriedTotal(u) >= s.carry) { returnAndDeposit(u); return; }
      goGather(u);
    } else if (u.type === UnitType.Archer) {
      const e = findNearestEnemyUnit(u.x, u.y, u.faction, s.sight);
      if (e) { kite(u, e.x, e.y, s); return; }
      if (carriedTotal(u) >= s.carry) { returnAndDeposit(u); return; }
      goGather(u);
    } else {
      const e = findNearestEnemyUnit(u.x, u.y, u.faction, s.sight);
      if (e) { flee(u, e.x, e.y); return; }
      if (carriedTotal(u) >= s.carry) { returnAndDeposit(u); return; }
      goGather(u);
    }
  }

  function chaseOrAttack(u, tx, ty, s) {
    const d = dist(u.x, u.y, tx, ty);
    u.aimX = (tx-u.x)/(d||1); u.aimY = (ty-u.y)/(d||1);
    if (d <= s.range) { u.moveX = 0; u.moveY = 0; u.wantAttack = true; }
    else { const len = d || 1; u.moveX = (tx - u.x) / len; u.moveY = (ty - u.y) / len; }
  }

  function kite(u, ex, ey, s) {
    const d = dist(u.x, u.y, ex, ey) || 1;
    u.aimX=(ex-u.x)/d; u.aimY=(ey-u.y)/d;
    const awayX = (u.x - ex) / d, awayY = (u.y - ey) / d;
    if (d < s.range * 0.6) { u.moveX = awayX; u.moveY = awayY; }
    else if (d <= s.range) { u.moveX = 0; u.moveY = 0; u.wantAttack = true; }
    else { u.moveX = -awayX; u.moveY = -awayY; }
  }

  function flee(u, ex, ey) {
    const d = dist(u.x, u.y, ex, ey) || 1;
    let ax = (u.x - ex) / d, ay = (u.y - ey) / d;
    const b = getBaseOfFaction(u.faction);
    if (b) {
      const bd = dist(u.x, u.y, b.x, b.y) || 1;
      ax += (b.x - u.x) / bd; ay += (b.y - u.y) / bd;
      const n = Math.hypot(ax, ay) || 1;
      ax /= n; ay /= n;
    }
    u.moveX = ax; u.moveY = ay;
  }

  function returnAndDeposit(u) {
    const b = game.bases.filter(b => b.faction === u.faction).reduce((nearest, candidate) =>
      !nearest || dist(u.x, u.y, candidate.x, candidate.y) < dist(u.x, u.y, nearest.x, nearest.y) ? candidate : nearest, null);
    if (!b) { u.moveX = 0; u.moveY = 0; return; }
    const d = dist(u.x, u.y, b.x, b.y);
    if (d <= 1.2) { doDeposit(u); u.moveX = 0; u.moveY = 0; }
    else { const len = d || 1; u.moveX = (b.x - u.x) / len; u.moveY = (b.y - u.y) / len; }
  }

  function chooseNode(u) {
    const f = game.factions[u.faction];
    let preferred = null;
    if (f) {
      if (f.resources.food < 25) preferred = ResourceType.Food;
      else if (f.resources.gold < 10) preferred = ResourceType.Gold;
      else if (f.resources.wood < 10) preferred = ResourceType.Wood;
      else if (f.resources.ore < 10) preferred = ResourceType.Ore;
    }
    if (preferred != null) {
      const n = findNearestNodeOfType(u.x, u.y, preferred);
      if (n) return n;
    }
    return findNearestNode(u.x, u.y);
  }

  function goGather(u) {
    const node = chooseNode(u);
    if (!node) { u.moveX = 0; u.moveY = 0; return; }
    const d = dist(u.x, u.y, node.x, node.y);
    if (d <= Config.gatherRange) { gather(u, node); u.moveX = 0; u.moveY = 0; }
    else { const len = d || 1; u.moveX = (node.x - u.x) / len; u.moveY = (node.y - u.y) / len; }
  }

  // ---------- 战斗 ----------
  function combatTarget(kind, id) {
    const list = kind === 'unit' ? game.units : kind === 'base' ? game.bases : kind === 'tower' ? game.towers : kind === 'site' ? game.sites : [];
    return list.find(e=>e.id===id);
  }
  function enemies(faction) {
    return [ ...game.units.map(e=>({e,kind:'unit',radius:.55})), ...game.bases.map(e=>({e,kind:'base',radius:1.9})), ...game.towers.map(e=>({e,kind:'tower',radius:.8})), ...game.sites.map(e=>({e,kind:'site',radius:1})) ].filter(t=>t.e.faction!==faction && t.e.hp>0);
  }
  function hitTarget(target, amount, attacker) {
    if(target.kind==='unit') damageUnit(target.e,amount,attacker);
    else if(target.kind==='base') damageBase(target.e,amount,attacker.faction);
    else if(target.kind==='tower') damageTower(target.e,amount,attacker.faction);
    else {target.e.hp-=amount;if(target.e.hp<=0)removeSite(target.e);}
  }
  function orderAttack(factionId,msg) {
    const target=combatTarget(msg.targetKind,msg.targetId);
    if(!target || target.faction===factionId || target.hp<=0)return {ok:false,error:'请选择有效的敌方目标'};
    const units=commandUnits(factionId,msg);
    for(const u of units){detachBuilder(u);u.commanded=true;u.pendingAttack=null;u.wantAttack=false;u.order={kind:msg.targetKind,id:msg.targetId};u.thinkTimer=0;}
    return {ok:units.length>0,count:units.length,error:units.length?undefined:'没有可指挥的己方单位'};
  }
  function commandUnits(factionId,msg){
    const ids=new Set(Array.isArray(msg.unitIds)?msg.unitIds.slice(0,128):[msg.unitId]);
    return game.units.filter(u=>ids.has(u.id)&&u.faction===factionId&&!u.possessed&&u.hp>0);
  }
  function commandMove(factionId,msg){
    const moving=msg.type==='order_move';
    if(moving){const error=World.movementError(msg.x,msg.y,game);if(error)return {ok:false,error};}
    const units=commandUnits(factionId,msg);
    for(const u of units){
      detachBuilder(u);u.commanded=true;u.pendingAttack=null;u.wantAttack=false;
      u.order=moving?{kind:'move',x:msg.x,y:msg.y}:null;u.thinkTimer=0;
    }
    return {ok:units.length>0,count:units.length,error:units.length?undefined:'没有可接管的己方单位'};
  }
  function orderHome(factionId,msg){
    const bases=game.bases.filter(b=>b.faction===factionId);
    if(!bases.length)return {ok:false,error:'当前没有己方基地可供返回'};
    const units=commandUnits(factionId,msg);
    for(const u of units){
      const base=bases.slice().sort((a,b)=>dist(u.x,u.y,a.x,a.y)-dist(u.x,u.y,b.x,b.y))[0];
      detachBuilder(u);u.pendingAttack=null;u.wantAttack=false;u.order={kind:'home',id:base.id};u.thinkTimer=0;
    }
    return {ok:units.length>0,count:units.length,error:units.length?undefined:'没有可指挥的己方单位'};
  }
  function unitAttack(u) {
    const s = Config.unitStats[u.type];
    if (u.pendingAttack || game.time - u.lastAttack < s.attackSpeed) return;
    u.lastAttack=u.attackStartedAt=game.time;u.attackSeq++;
    u.attackAimX=u.aimX;u.attackAimY=u.aimY;
    // An empty swing / shot still has an animation and consumes its cooldown.
    u.pendingAttack={at:game.time+(u.type===UnitType.Archer?.38:.16)};
    if(u.type!==UnitType.Archer){
      const targets=enemies(u.faction).filter(t=>inMeleeReach(u,t));
      u.pendingAttack.target=u.order
        ? targets.find(t=>t.kind===u.order.kind && t.e.id===u.order.id)
        : targets.sort((a,b)=>dist(u.x,u.y,a.e.x,a.e.y)-dist(u.x,u.y,b.e.x,b.e.y))[0];
    }
  }
  function inMeleeReach(u,target){
    const x=target.e.x-u.x,y=target.e.y-u.y,d=Math.hypot(x,y);
    return d<=Config.unitStats[u.type].range+target.radius && (d<.2||(x*u.aimX+y*u.aimY)/d>.35);
  }
  function resolveAttack(u) {
    if(!u.pendingAttack || game.time<u.pendingAttack.at)return;
    const target=u.pendingAttack.target;
    u.pendingAttack=null;
    const s=Config.unitStats[u.type], amount=s.attack*(u.possessed?Config.possessBuffAttack:1)*attackMult(u.faction);
    const dx=u.aimX,dy=u.aimY;
    u.attackAimX=dx;u.attackAimY=dy;
    if(u.type===UnitType.Archer){
      game.projectiles.push({id:nextId++,faction:u.faction,ownerId:u.id,x:u.x,y:u.y,dx,dy,remaining:s.range,speed:24,damage:amount});
    }else if(target && target.e.faction!==u.faction && target.e.hp>0 &&
             combatTarget(target.kind,target.e.id)===target.e && inMeleeReach(u,target)){
      hitTarget(target,amount,u);
    }
  }
  function tickProjectiles(dt) {
    for(const p of game.projectiles.slice()){
      const travel=Math.min(p.remaining,p.speed*dt);
      let best=null,hitDistance=Infinity;
      for(const t of enemies(p.faction)){
        const x=t.e.x-p.x,y=t.e.y-p.y,along=x*p.dx+y*p.dy;
        const perpendicular=x*x+y*y-along*along, r=t.radius+.08;
        if(perpendicular>r*r)continue;
        const offset=Math.sqrt(Math.max(0,r*r-perpendicular));
        if(along+offset<0)continue;
        const entry=Math.max(0,along-offset);
        if(entry<=travel && entry<hitDistance){best=t;hitDistance=entry;}
      }
      if(best){
        const owner=game.units.find(u=>u.id===p.ownerId)||{faction:p.faction};
        hitTarget(best,p.damage,owner);p.remaining=0;
      }else{p.x+=p.dx*travel;p.y+=p.dy*travel;p.remaining-=travel;}
      if(p.remaining<=0)game.projectiles.splice(game.projectiles.indexOf(p),1);
    }
  }

  function towerAttackValue(t) { return Config.towerAttack * (1 + ((t.level || 1) - 1) * Config.towerUpgradeAttackBonus); }
  function towerRangeValue(t) { return Config.towerRange + ((t.level || 1) - 1) * Config.towerUpgradeRangeBonus; }
  function towerMaxHpValue(t) { return Math.round(Config.towerHp * (1 + ((t.level || 1) - 1) * Config.towerUpgradeHpBonus)); }

  function towerAttack(t) {
    if (game.time - t.lastAttack < Config.towerAttackSpeed) return;
    const range = towerRangeValue(t);
    const e = findNearestEnemyUnit(t.x, t.y, t.faction, range);
    if (e) { t.lastAttack = game.time; damageUnit(e, towerAttackValue(t), t); return; }
    const eb = findNearestEnemyBase(t.x, t.y, t.faction, range);
    if (eb) { t.lastAttack = game.time; damageBase(eb, towerAttackValue(t), t.faction); }
  }

  function damageUnit(u, dmg, attacker) {
    u.hp -= dmg;
    if (u.hp <= 0) {
      const i = game.units.indexOf(u);
      if (i >= 0) game.units.splice(i, 1);
      if (attacker) {
        addScore(attacker.faction, u.possessed ? Config.scorePossessedKill : Config.scoreKill);
        addResource(attacker.faction, 'gold', Config.killRewardGold);
      }
    }
  }

  function damageBase(b, dmg, attackerFaction) {
    b.hp -= dmg;
    if (b.hp <= 0) {
      b.hp = b.maxHp;
      b.faction = attackerFaction; // 抢占
      addScore(attackerFaction, Config.scoreBaseCapture);
    }
  }

  function damageTower(t, dmg, attackerFaction) {
    t.hp -= dmg;
    if (t.hp <= 0) {
      const i = game.towers.indexOf(t);
      if (i >= 0) game.towers.splice(i, 1);
      addScore(attackerFaction, Config.scoreTowerDestroy);
    }
  }

  // ---------- 基地生产 ----------
  function baseProduce(b, dt) {
    if(game.factions[b.faction]?.buildPreviewUntil>game.time)return;
    b.spawnTimer -= dt;
    if (b.spawnTimer > 0) return;
    b.spawnTimer = baseSpawnIntervalValue(b);
    const owned = unitsOfFaction(b.faction).length;
    if (owned >= Config.maxUnitsPerFaction) return;
    if (!trySpend(b.faction, Config.unitSpawnCostGold, Config.unitSpawnCostFood, 0, 0)) {
      // A faction with a base but no units cannot gather, so it can never afford its next
      // unit (food upkeep and starvation emptied it). Hand out one free worker to break the deadlock.
      if (owned === 0) spawnUnit(b.faction, UnitType.Worker, b.x + (Math.random() * 4 - 2), b.y + (Math.random() * 4 - 2));
      return;
    }
    const type = Math.floor(Math.random() * 3);
    spawnUnit(b.faction, type, b.x + (Math.random() * 4 - 2), b.y + (Math.random() * 4 - 2));
  }

  function nodeRespawn(n, dt) {
    if (n.amount <= 0) {
      n.respawnTimer -= dt;
      if (n.respawnTimer <= 0) n.amount = n.maxAmount;
    }
  }

  // ---------- 经济 ----------
  function tickEconomy() {
    const counts = new Map();
    for (const u of game.units) counts.set(u.faction, (counts.get(u.faction) || 0) + 1);
    for (const [fid, count] of counts) {
      const f = game.factions[fid];
      if (!f) continue;
      // 小数累加：0.2/单位/秒，累计够 1 才扣 1 粮食
      f.foodDebt = (f.foodDebt || 0) + count * Config.upkeepFoodPerUnitPerSecond;
      const due = Math.floor(f.foodDebt);
      f.foodDebt -= due;
      if (f.resources.food >= due) {
        f.resources.food -= due;
      } else {
        f.resources.food = 0;
        for (const u of game.units.slice()) {
          if (u.faction === fid) {
            u.starvationDamage=(u.starvationDamage||0)+Config.starvationDamagePerTick;
            damageUnit(u, Config.starvationDamagePerTick, null);
          }
        }
      }
    }
  }

  // ---------- 胜负 ----------
  function isAlive(factionId) {
    if (game.bases.some(b => b.faction === factionId)) return true;
    if (game.units.some(u => u.faction === factionId)) return true;
    return false;
  }

  function resultByScore() {
    const scores = {};
    for (const fid in game.factions) {
      const f = game.factions[fid];
      if (f.surrendered) continue;
      const target = rootFaction(Number(fid));
      let total = f.score;
      total += Math.floor((f.resources.gold + f.resources.food + f.resources.wood + f.resources.ore) / 100);
      scores[target] = (scores[target] || 0) + total;
    }
    let bestFaction = -1, bestScore = -Infinity;
    for (const k in scores) {
      if (scores[k] > bestScore) { bestScore = scores[k]; bestFaction = Number(k); }
    }
    return '时间到，积分最高阵营 ' + bestFaction + '（' + bestScore + ' 分）胜';
  }

  function checkWin() {
    const alive = new Set();
    for (const b of game.bases) if (b.faction !== -1) alive.add(b.faction);
    for (const u of game.units) if (u.faction !== -1) alive.add(u.faction);
    for (const fid in game.factions) {
      if (game.factions[fid].surrendered) alive.delete(Number(fid));
    }
    if (alive.size <= 1) {
      let winner = null;
      for (const x of alive) winner = x;
      game.state = 'over';
      game.resultText = winner == null ? '平局' : '阵营 ' + winner + ' 胜';
      return;
    }
    if (game.timeLeft <= 0) {
      game.state = 'over';
      game.resultText = resultByScore();
    }
  }

  // ---------- 玩家操作 ----------
  function refreshMaxHp(u) {
    const ratio=u.hp/u.maxHp;
    u.maxHp=Math.round(Config.unitStats[u.type].maxHp*hpMult(u.faction)*(u.possessed?Config.possessBuffHp:1));
    u.hp=Math.min(u.maxHp,ratio*u.maxHp);
  }
  function possessUnit(factionId, unit) {
    if (!unit) return;
    if(unit.possessed)return;
    releaseUnit(factionId);
    detachBuilder(unit);
    unit.possessed = true;unit.commanded=false;
    refreshMaxHp(unit);
    unit.order=null;unit.pendingAttack=null;
    unit.moveX = unit.moveY = 0;
    unit.wantAttack = false;
  }

  function releaseUnit(factionId) {
    for (const u of game.units) if (u.possessed && u.faction === factionId) {
      u.possessed = false;
      refreshMaxHp(u);
      u.pendingAttack=null;
      u.moveX = u.moveY = 0;
      u.wantAttack = false;
      u.thinkTimer = 0;
    }
  }

  function possessSwitch(factionId) {
    const own = game.units.filter(u => u.faction === factionId);
    if (own.length === 0) return;
    const cur = possessedUnitOf(factionId);
    const idx = own.indexOf(cur);
    const next = own[(idx + 1) % own.length];
    possessUnit(factionId, next);
  }

  function control(factionId, dx, dy, attack, aimX, aimY) {
    const u = possessedUnitOf(factionId);
    if (!u) return;
    u.moveX = Number.isFinite(dx)?Math.max(-1,Math.min(1,dx)):0;
    u.moveY = Number.isFinite(dy)?Math.max(-1,Math.min(1,dy)):0; u.wantAttack = attack;
    if(Number.isFinite(aimX)&&Number.isFinite(aimY)){
      const len=Math.hypot(aimX,aimY);if(len>.001){u.aimX=aimX/len;u.aimY=aimY/len;}
    }
  }

  function upgradeFaction(factionId) {
    const lv = upgradeLevel(factionId);
    if (lv >= Config.maxUpgradeLevel) return;
    const goldCost = Config.upgradeBaseCostGold * lv;
    if (!trySpend(factionId, goldCost, 0, 0, Config.upgradeOreCost)) return;
    game.factions[factionId].upgradeLevel = lv + 1;
    for (const u of game.units) {
      if (u.faction === factionId) {
        refreshMaxHp(u);
        u.hp = u.maxHp;
        u.regenTimer=0;
      }
    }
  }

  function availableBuilders(factionId, includeCommanded=false) {
    return game.units.filter(u=>u.faction===factionId && u.type===UnitType.Worker && !u.possessed && u.buildSiteId==null && !u.order && (includeCommanded||!u.commanded) && u.hp>0);
  }
  function assignBuilder(site, worker) {
    site.workerId=worker.id;site.status='travel';worker.buildSiteId=site.id;
    worker.order=null;worker.commanded=false;worker.pendingAttack=null;worker.wantAttack=false;worker.thinkTimer=0;
  }
  function detachBuilder(u) {
    const site=game.sites.find(b=>b.id===u.buildSiteId);
    if(site){site.workerId=null;site.status='waiting';}
    u.buildSiteId=null;u.moveX=u.moveY=0;
  }
  function removeSite(site) {
    const worker=game.units.find(u=>u.id===site.workerId);
    if(worker && worker.buildSiteId===site.id){detachBuilder(worker);worker.thinkTimer=0;}
    const index=game.sites.indexOf(site);if(index>=0)game.sites.splice(index,1);
  }
  function buildTower(factionId, msg) {
    const f=game.factions[factionId];
    if(!f||f.surrendered)return {ok:false,error:'当前阵营不能建造'};
    const {x,y}=msg;
    const error=World.placementError(x,y,game,factionId);if(error)return {ok:false,error};
    const candidates=availableBuilders(factionId,true).sort((a,b)=>dist(a.x,a.y,x,y)-dist(b.x,b.y,x,y));
    const worker=candidates.find(u=>u.id===msg.workerId)||candidates[0];
    if(!worker)return {ok:false,error:'没有可用工人，请等待施工结束或让工人退出化身/攻击指令'};
    if(!trySpend(factionId,Config.towerCostGold,0,Config.towerCostWood,0,true))return {ok:false,error:'资源不足：需要 15 金币和 30 木材'};
    f.buildPreviewUntil=0;
    const site={id:nextId++,faction:factionId,x,y,hp:100,maxHp:100,progress:0,duration:Config.towerBuildSeconds,workerId:null,status:'travel'};
    game.sites.push(site);assignBuilder(site,worker);
    return {ok:true,siteId:site.id,workerId:worker.id};
  }
  function beginBuildPreview(factionId) {
    const f=game.factions[factionId];
    if(!f||f.surrendered)return {ok:false,error:'当前阵营不能建造'};
    if(!game.bases.some(b=>b.faction===factionId))return {ok:false,error:'需要拥有己方基地才能建造'};
    if(f.resources.gold<Config.towerCostGold||f.resources.wood<Config.towerCostWood)return {ok:false,error:'资源不足：需要 15 金币和 30 木材'};
    f.buildPreviewUntil=game.time+10;
    return {ok:true};
  }
  function cancelBuild(factionId,siteId) {
    const site=game.sites.find(b=>b.id===siteId&&b.faction===factionId);
    if(!site)return {ok:false,error:'施工地点已不存在'};
    const remaining=1-site.progress/site.duration;
    const gold=Math.floor(Config.towerCostGold*remaining),wood=Math.floor(Config.towerCostWood*remaining);
    addResource(factionId,'gold',gold);addResource(factionId,'wood',wood);removeSite(site);
    return {ok:true,gold,wood};
  }
  function upgradeTower(factionId,msg) {
    const t=game.towers.find(x=>x.id===msg.towerId&&x.faction===factionId);
    if(!t)return {ok:false,error:'箭塔不存在或不属于己方阵营'};
    if(t.level>=Config.towerMaxLevel)return {ok:false,error:'箭塔已经达到最高等级'};
    const gold=Config.towerUpgradeCostGold*t.level,wood=Config.towerUpgradeCostWood*t.level;
    if(!trySpend(factionId,gold,0,wood,0,true))return {ok:false,error:`资源不足：升级需要 ${gold} 金币和 ${wood} 木材`};
    t.level+=1;
    t.maxHp=towerMaxHpValue(t);
    t.hp=t.maxHp;
    return {ok:true,level:t.level,towerId:t.id};
  }
  function upgradeBase(factionId,msg) {
    const b=game.bases.find(x=>x.id===msg.baseId&&x.faction===factionId);
    if(!b)return {ok:false,error:'基地不存在或不属于己方阵营'};
    if(b.level>=Config.baseMaxLevel)return {ok:false,error:'基地已经达到最高等级'};
    const gold=Config.baseUpgradeCostGold*b.level,ore=Config.baseUpgradeCostOre*b.level;
    if(!trySpend(factionId,gold,0,0,ore,true))return {ok:false,error:`资源不足：升级需要 ${gold} 金币和 ${ore} 矿石`};
    b.level+=1;
    b.maxHp=baseMaxHpValue(b);
    b.hp=b.maxHp;
    return {ok:true,level:b.level,baseId:b.id};
  }
  function upgradeResource(factionId,msg) {
    const n=game.nodes.find(x=>x.id===msg.nodeId);
    if(!n)return {ok:false,error:'资源点不存在'};
    if(n.owner!==factionId)return {ok:false,error:'该资源点不属于己方阵营'};
    const base=game.bases.filter(b=>b.faction===factionId).reduce((best,b)=>!best||b.level>best.level?b:best,null);
    if(!base)return {ok:false,error:'需要拥有己方基地才能升级资源'};
    if(n.level>=Config.resourceMaxLevel)return {ok:false,error:'资源点已经达到最高等级'};
    if(n.level>=base.level)return {ok:false,error:`需要基地达到 Lv.${n.level+1} 才能升级该资源`};
    const gold=Config.resourceUpgradeCostGold*n.level,wood=Config.resourceUpgradeCostWood*n.level;
    if(!trySpend(factionId,gold,0,wood,0,true))return {ok:false,error:`资源不足：升级需要 ${gold} 金币和 ${wood} 木材`};
    n.level+=1;
    n.maxAmount=nodeMaxAmountValue(n);
    n.amount=n.maxAmount;
    return {ok:true,level:n.level,nodeId:n.id};
  }
  function tickConstruction(dt) {
    for(const site of game.sites.slice()){
      let worker=game.units.find(u=>u.id===site.workerId && u.faction===site.faction && !u.possessed && u.buildSiteId===site.id);
      if(!worker){
        site.workerId=null;site.status='waiting';
        worker=availableBuilders(site.faction).sort((a,b)=>dist(a.x,a.y,site.x,site.y)-dist(b.x,b.y,site.x,site.y))[0];
        if(worker)assignBuilder(site,worker);else continue;
      }
      if(dist(worker.x,worker.y,site.x,site.y)>Config.buildRange){site.status='travel';continue;}
      site.status='building';worker.moveX=worker.moveY=0;
      site.progress=Math.min(site.duration,site.progress+dt);
      if(site.progress+1e-8>=site.duration){
        const tower=spawnTower(site.faction,site.x,site.y);
        tower.hp=tower.maxHp*(site.hp/site.maxHp);tower.lastAttack=game.time;
        removeSite(site);
      }
    }
  }
  function tickRegeneration(dt) {
    for(const u of game.units){
      if(u.hp>=u.maxHp){u.regenTimer=0;continue;}
      u.regenTimer+=dt;
      while(u.regenTimer+1e-8>=Config.regenerationSeconds){
        u.regenTimer-=Config.regenerationSeconds;
        u.hp=Math.min(u.maxHp,u.hp+u.maxHp*Config.regenerationFraction);
        if(u.hp>=u.maxHp){u.regenTimer=0;break;}
      }
    }
  }

  function surrender(factionId) {
    const f = game.factions[factionId];
    if (!f || f.surrendered) return;
    f.surrendered = true;
    f.buildPreviewUntil=0;
    for(const site of game.sites.slice())if(site.faction===factionId)removeSite(site);
    for (let i = game.units.length - 1; i >= 0; i--) if (game.units[i].faction === factionId) game.units.splice(i, 1);
    for (let i = game.bases.length - 1; i >= 0; i--) if (game.bases[i].faction === factionId) game.bases.splice(i, 1);
    for (let i = game.towers.length - 1; i >= 0; i--) if (game.towers[i].faction === factionId) game.towers.splice(i, 1);
  }

  // Resolve A -> B -> C chains to C so scores, ownership and bans stay consistent.
  function rootFaction(factionId) {
    let current = factionId;
    const seen = new Set();
    while (game.factions[current]?.joinedFactionId > 0 && !seen.has(current)) {
      seen.add(current);
      current = game.factions[current].joinedFactionId;
    }
    return current;
  }

  function joinFaction(factionId, target) {
    const f = game.factions[factionId];
    if (!f || f.surrendered) return {ok:false,error:'当前阵营不能加入其它阵营'};
    if (f.joinedFactionId > 0) return {ok:false,error:'本局已经加入过阵营'};
    const root = Number.isInteger(target) ? rootFaction(target) : -1;
    if (target <= 0 || !game.factions[root] || game.factions[root].surrendered)
      return {ok:false,error:'目标阵营不存在或已退出'};
    if (root === rootFaction(factionId)) return {ok:false,error:'不能加入自己或已合并的阵营'};
    releaseUnit(factionId);
    f.buildPreviewUntil = 0;
    f.joinedFactionId = root;
    const rf = game.factions[root];
    for (const key of ['gold', 'food', 'wood', 'ore']) { rf.resources[key] += f.resources[key]; f.resources[key] = 0; }
    rf.score += f.score; f.score = 0;
    rf.foodDebt = (rf.foodDebt || 0) + (f.foodDebt || 0); f.foodDebt = 0;
    for (const u of game.units) if (u.faction === factionId) u.faction = root;
    for (const b of game.bases) if (b.faction === factionId) b.faction = root;
    for (const t of game.towers) if (t.faction === factionId) t.faction = root;
    for (const site of game.sites) if (site.faction === factionId) site.faction = root;
    for (const p of game.projectiles) if (p.faction === factionId) p.faction = root;
    for (const n of game.nodes) if (n.owner === factionId) n.owner = root;
    return {ok:true,target:root};
  }

  function handleMessage(factionId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (game.state === 'over') return ['build_tower','cancel_build','begin_build'].includes(msg.type)?{ok:false,error:'本局已经结束'}:undefined;
    switch (msg.type) {
      case 'release': releaseUnit(factionId); break;
      case 'control': control(factionId, msg.dx || 0, msg.dy || 0, !!msg.attack,msg.aimX,msg.aimY); break;
      case 'order_attack': return orderAttack(factionId,msg);
      case 'order_home': return orderHome(factionId,msg);
      case 'take_control':
      case 'order_move': return commandMove(factionId,msg);
      case 'cancel_order': {
        for(const u of commandUnits(factionId,msg)){u.commanded=false;u.order=null;u.pendingAttack=null;u.wantAttack=false;u.moveX=u.moveY=0;u.thinkTimer=0;}break;
      }
      case 'possess_switch': possessSwitch(factionId); break;
      case 'possess': {
        const u = game.units.find(x => x.id === msg.unitId && x.faction === factionId);
        if (u) possessUnit(factionId, u);
        break;
      }
      case 'upgrade': upgradeFaction(factionId); break;
      case 'build_tower': return buildTower(factionId,msg);
      case 'upgrade_tower': return upgradeTower(factionId,msg);
      case 'upgrade_base': return upgradeBase(factionId,msg);
      case 'upgrade_resource': return upgradeResource(factionId,msg);
      case 'begin_build': return beginBuildPreview(factionId);
      case 'build_preview_keepalive': if(game.factions[factionId]?.buildPreviewUntil>game.time)game.factions[factionId].buildPreviewUntil=game.time+10;break;
      case 'end_build': if(game.factions[factionId])game.factions[factionId].buildPreviewUntil=0;break;
      case 'cancel_build': return cancelBuild(factionId,msg.siteId);
      case 'surrender': surrender(factionId); break;
      case 'join_faction': return joinFaction(factionId, msg.target);
    }
  }

  // ---------- 主循环 ----------
  function tick(dt) {
      case 'end_game':
        if(game.state==='running'){
          game.state='over';
          game.resultText='本局已提前结束';
        }
        break;
    game.time += dt;

    if (game.state === 'waiting') {
      if (Object.keys(game.players).length > 0) {
        ensureMinPlayers();
        game.state = 'running';
      }
      return;
    }
    if (game.state !== 'running') return;

    game.timeLeft -= dt;
    game.economyTimer -= dt;

    for (const u of game.units.slice()) {
      // Every in-tick death goes through damageUnit(), which sets hp <= 0 before
      // splicing; this avoids an O(N^2) includes() scan for every unit each tick.
      if (u.hp <= 0) continue;
      aiThink(u, dt);
      const s = Config.unitStats[u.type];
      const sp = s.speed * (u.possessed ? Config.possessBuffSpeed : 1);
      const len = Math.hypot(u.moveX, u.moveY);
      if(u.order?.kind==='move'&&!u.possessed){
        const dx=u.order.x-u.x,dy=u.order.y-u.y,d=Math.hypot(dx,dy);
        if(d<=sp*dt){u.x=u.order.x;u.y=u.order.y;u.order=null;u.moveX=u.moveY=0;}
        else{u.x+=dx/d*sp*dt;u.y+=dy/d*sp*dt;}
      }else if (len > 0.0001) { u.x += (u.moveX / len) * sp * dt; u.y += (u.moveY / len) * sp * dt; }
      u.x = Math.max(-Config.mapHalf, Math.min(Config.mapHalf, u.x));
      u.y = Math.max(-Config.mapHalf, Math.min(Config.mapHalf, u.y));
      if (u.wantAttack) { unitAttack(u); u.wantAttack = false; }
      resolveAttack(u);
    }

    tickProjectiles(dt);
    tickConstruction(dt);

    for (const t of game.towers.slice()) { if (game.towers.includes(t)) towerAttack(t); }
    for (const b of game.bases.slice()) { if (game.bases.includes(b)) baseProduce(b, dt); }
    for (const n of game.nodes) nodeRespawn(n, dt);

    while (game.economyTimer <= 1e-8) { game.economyTimer += 1; tickEconomy(); }
    tickRegeneration(dt);

    checkWin();
  }

  // ---------- 序列化（发送给某个阵营的视角） ----------
  // Constant rules are sent once with `welcome`, not in every 20 Hz snapshot.
  function rulesSnapshot() {
    return {
      towerBuildSeconds: Config.towerBuildSeconds, buildRadius: World.buildRadius,
      regenSeconds: Config.regenerationSeconds, regenFraction: Config.regenerationFraction,
      towerMaxLevel: Config.towerMaxLevel, towerUpgradeCostGold: Config.towerUpgradeCostGold,
      towerUpgradeCostWood: Config.towerUpgradeCostWood, towerUpgradeAttackBonus: Config.towerUpgradeAttackBonus,
      towerUpgradeHpBonus: Config.towerUpgradeHpBonus, towerUpgradeRangeBonus: Config.towerUpgradeRangeBonus,
      baseMaxLevel: Config.baseMaxLevel, baseUpgradeCostGold: Config.baseUpgradeCostGold,
      baseUpgradeCostOre: Config.baseUpgradeCostOre, baseUpgradeHpBonus: Config.baseUpgradeHpBonus,
      baseSpawnSpeedBonus: Config.baseSpawnSpeedBonus, resourceMaxLevel: Config.resourceMaxLevel,
      resourceUpgradeCostGold: Config.resourceUpgradeCostGold, resourceUpgradeCostWood: Config.resourceUpgradeCostWood,
      resourceYieldBonus: Config.resourceYieldBonus,
    };
  }

  function serializeFor(factionId) {
    const f = game.factions[factionId];
    const possessed = possessedUnitOf(factionId);
    const alive = new Set();
    for (const b of game.bases) if (b.faction !== -1) alive.add(b.faction);
    for (const u of game.units) if (u.faction !== -1) alive.add(u.faction);
    const compactOrder = o => !o ? null : Number.isFinite(o.x) ? {kind:o.kind,x:r2(o.x),y:r2(o.y)} : o;
    return {
      type: 'state',
      time: game.time,
      sites: game.sites.map(s => ({...s, x:r2(s.x), y:r2(s.y), progress:r2(s.progress)})),
      projectiles: game.projectiles.map(p => ({id:p.id,x:r2(p.x),y:r2(p.y),dx:r2(p.dx),dy:r2(p.dy),faction:p.faction})),
      timeLeft: r2(Math.max(0, game.timeLeft)),
      matchState: game.state,
      resultText: game.resultText,
      you: {
        faction: factionId,
        name: f ? f.name : '',
        resources: f ? f.resources : { gold: 0, food: 0, wood: 0, ore: 0 },
        score: f ? f.score : 0,
        upgradeLevel: f ? f.upgradeLevel : 1,
        surrendered: f ? f.surrendered : false,
        ...(f && f.joinedFactionId > 0 ? {mergedInto: rootFaction(factionId)} : {}),
        possessedUnitId: possessed ? possessed.id : null,
        buildBudgetProtected: !!f && f.buildPreviewUntil>game.time,
      },
      units: game.units.map(u => {
        const out = {
          id:u.id, faction:u.faction, type:u.type, x:r2(u.x), y:r2(u.y),
          hp:r2(u.hp), maxHp:u.maxHp, attackStartedAt:r2(u.attackStartedAt),
          aimX:r2(u.aimX), aimY:r2(u.aimY), attack:safeAttack(u),
          range:Config.unitStats[u.type].range, attackSpeed:Config.unitStats[u.type].attackSpeed,
        };
        // Default-valued keys are omitted; the client treats missing fields as false/null.
        // attackAimX/Y and regenTimer were never read by the renderer, so they are gone.
        if (u.possessed) out.possessed = true;
        if (u.attackSeq) out.attackSeq = u.attackSeq;
        if (u.order) out.order = compactOrder(u.order);
        if (u.commanded) out.commanded = true;
        if (u.buildSiteId != null) out.buildSiteId = u.buildSiteId;
        return out;
      }),
      bases: game.bases.map(b => ({ id: b.id, faction: b.faction, x: r2(b.x), y: r2(b.y), hp: r2(b.hp), maxHp: b.maxHp, level: b.level, spawnInterval: r2(baseSpawnIntervalValue(b)) })),
        if (u.starvationDamage) out.starvationDamage = u.starvationDamage;
      towers: game.towers.map(t => ({ id: t.id, faction: t.faction, x: r2(t.x), y: r2(t.y), hp: r2(t.hp), maxHp: t.maxHp, level: t.level, attack: r2(towerAttackValue(t)), range: towerRangeValue(t) })),
      nodes: game.nodes.map(n => ({ id: n.id, type: n.type, x: r2(n.x), y: r2(n.y), amount: n.amount, maxAmount: n.maxAmount, level: n.level, owner: n.owner })),
      factions: Object.keys(game.factions).map(k => {
        const entry = game.factions[k];
        return {
          id:Number(k), name:entry.name, score:entry.score,
          surrendered:entry.surrendered, alive:alive.has(Number(k)),
          ...(entry.joinedFactionId > 0 ? {mergedInto:rootFaction(Number(k))} : {}),
        };
      }),
    };
  }

  initMap();

  // 公开 API（挂到 game 上便于测试）
  game.registerPlayer = registerPlayer;
  game.addAiFaction = addAiFaction;
  game.handleMessage = handleMessage;
  game.tick = tick;
  game.serializeFor = serializeFor;
  game.rulesSnapshot = rulesSnapshot;
  game.maxPlayers = World.spawns.length;
  game.rootFaction = rootFaction;
  game.Config = Config;
  game.ResourceType = ResourceType;
  game.UnitType = UnitType;
  return game;
}

module.exports = { createGame, Config, ResourceType, UnitType };
