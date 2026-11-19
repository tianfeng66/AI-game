import { ValleyScene, factionColor } from './scene.js';

const $ = id => document.getElementById(id);
const names = ['工人', '战士', '射手'];
const keys = new Set();
let view, latest = null, faction = null, socket, lastSend = 0, lastFrame = performance.now(), lastHud = 0;
let toastTimer, dragging = false, dragMoved = false, lastPointer = null, joined = false;
let previousPossession = null, rosterKey = '', ranksKey = '';
let commandId=null,attackQueued=false,dragOrigin=null;
let selectedIds=new Set(),selectionDrag=null,suppressClickUntil=0,attackTargeting=false;
let placement=null,pendingBuild=false,sitesKey='';
let selectedTowerId=null,towerPanelKey='';
let selectedBaseId=null,selectedNodeId=null,basePanelKey='',nodePanelKey='';
let aimPointer={x:innerWidth/2,y:innerHeight/2},pointerOnMap=true,previewHeartbeat=0,buildRequestSequence=0,pendingBuildRequest=null;
let staticRules=null,reconnectTimer=null,sessionSuperseded=false;
let startupResolve=null,startupReject=null,startupTimeout=null,startupSignal=null;

function makeClientId(){
  try{
    let id=localStorage.getItem('stickman-client-id');
    if(!id){id='c-'+Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('stickman-client-id',id);}
    return id;
  }catch{return 'c-'+Math.random().toString(36).slice(2);}
}
const clientId=makeClientId();
function playerName(){return ($('player-name')?.value||'').trim()||'河谷旅人';}

function toast(text) {
  $('toast').textContent = text; $('toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3200);
}
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function selected() { return latest?.units.find(u => u.id === latest.you.possessedUnitId); }
function canAct() { return joined && !sessionSuperseded && latest?.matchState === 'running' && !latest.you?.surrendered && !latest.you?.mergedInto; }
function release() { keys.clear();attackQueued=false;send({type:'release'}); }
function setSelection(ids){
  selectedIds=new Set(ids.filter(id=>latest?.units.some(u=>u.id===id&&u.faction===faction)));
  if(!selectedIds.has(commandId))commandId=selectedIds.values().next().value??null;
  view.commandId=commandId;view.selectedIds=selectedIds;
  if(!selectedIds.size)attackTargeting=false;
}
function chooseUnit(id,additive=false){
  if(!canAct())return;
  if(selectedTowerId!=null||selectedBaseId!=null||selectedNodeId!=null)clearBuildingSelection();
  if(selected()){possess(id);return;}
  const ids=additive?new Set(selectedIds):new Set();
  if(additive&&ids.has(id))ids.delete(id);else ids.add(id);
  setSelection([...ids]);takeControl();
}
function takeControl(){
  if(selectedIds.size)send({type:'take_control',unitIds:[...selectedIds]});
}
function commandMove(x,y){
  if(!canAct()||selected()||!selectedIds.size)return;
  const point=view.movementPoint(x,y);
  if(point.error){toast(point.error);return;}
  view.showMoveFlag(point.x,point.y);
  attackTargeting=false;send({type:'order_move',unitIds:[...selectedIds],x:point.x,y:point.y});
}
function commandAttack(target){
  if(!canAct()||selected()||!selectedIds.size||!target)return;
  attackTargeting=false;
  send({type:'order_attack',unitIds:[...selectedIds],targetId:target.id,targetKind:target.kind});
}
function targetAttack(){if(!canAct()||selected()||!selectedIds.size||placement)return;attackTargeting=true;toast('点击敌方单位或建筑，让选中部队集中攻击');}
function goHome(){if(!canAct()||selected()||!selectedIds.size||placement)return;attackTargeting=false;send({type:'order_home',unitIds:[...selectedIds]});}
function cancelOrder(){if(!selected()&&selectedIds.size){attackTargeting=false;send({type:'cancel_order',unitIds:[...selectedIds]});toast('已取消选中部队的指令，恢复自动行动');}}
function possess(id) {
  if (!canAct()) return;
  if(placement)cancelPlacement();
  keys.clear();attackQueued=false;
  const target=id??(!selected()?commandId:null);
  send(target == null ? {type:'possess_switch'} : {type:'possess',unitId:target});
}
function upgrade() {
  if(!canAct()) return;
  const {resources:r,upgradeLevel:lv}=latest.you;
  if(lv>=5)return toast('阵营已经达到最高等级');
  if(r.gold<lv*50||r.ore<20)return toast(`升级需要 ${lv*50} 金币和 20 矿石`);
  send({type:'upgrade'});toast('阵营升级：全体单位提升攻击与生命');
}
function build() {
  if(!canAct()) return;
  if(selectedTowerId!=null||selectedBaseId!=null||selectedNodeId!=null)clearBuildingSelection();
  if(placement){cancelPlacement();return;}
  const r=latest.you.resources;
  if(r.gold<15||r.wood<30)return toast('建造箭塔需要 15 金币和 30 木材');
  if(!latest.units.some(u=>u.faction===faction&&u.type===0&&u.buildSiteId==null&&!u.order))return toast('没有可用工人，请等待或先取消工人的攻击指令');
  const base=latest.bases.find(b=>b.faction===faction);
  if(!base)return toast('需要拥有己方基地才能建造');
  release();
  endSelectionDrag();attackTargeting=false;
  send({type:'begin_build'});previewHeartbeat=performance.now();
  const origin=base;
  placement={x:origin.x+8,y:origin.y,locked:false};view.focus.set(origin.x,0,origin.y);view.zoom=.65;
  $('placement-panel').classList.remove('hidden');updatePlacement();
  toast('单击地图锁定位置，双击建造；再次单击可换位置，Esc 取消');
}
function cancelPlacement(){if(placement)send({type:'end_build'});placement=null;pendingBuild=false;pendingBuildRequest=null;view?.hideBuildPreview();$('placement-panel').classList.add('hidden');}
function updatePlacement(){
  if(!placement||!latest)return;
  const error=globalThis.World.placementError(placement.x,placement.y,latest,faction);
  const workers=latest.units.filter(u=>u.faction===faction&&u.type===0&&!u.possessed&&u.buildSiteId==null&&!u.order);
  const available=workers.length>0,affordable=latest.you.resources.gold>=15&&latest.you.resources.wood>=30;
  view.showBuildPreview(placement.x,placement.y,!error&&available&&affordable,faction);
  $('placement-position').textContent=`${placement.locked?'已锁定':'预览'} ${placement.x.toFixed(1)} / ${placement.y.toFixed(1)}`;
  $('placement-help').textContent=error||(!placement.locked?'单击地图锁定位置，锁定后不再跟随鼠标':!available?'等待可用工人；化身工人需先返回俯视':!affordable?'资源不足：15 金币 · 30 木材':!latest.you.buildBudgetProtected?'正在保护建造预算…':`位置已锁定 · 双击建造或点击确认 · 施工 ${latest.rules?.towerBuildSeconds||12} 秒`);
  $('confirm-build').disabled=!!error||!placement.locked||!available||!affordable||pendingBuild||!latest.you.buildBudgetProtected;
  $('confirm-build').textContent=pendingBuild?'正在派遣…':'确认施工';
}
function movePlacement(event,lock=false){if(!placement||pendingBuild)return;const point=view.groundPoint(event.clientX,event.clientY);if(point){placement={x:Math.round(point.x*10)/10,y:Math.round(point.y*10)/10,locked:lock};updatePlacement();}}
function confirmPlacement(){
  if(!placement||pendingBuild)return;
  updatePlacement();
  if($('confirm-build').disabled)return;
  pendingBuild=true;pendingBuildRequest='build-'+(++buildRequestSequence);
  send({type:'build_tower',x:placement.x,y:placement.y,workerId:commandId,requestId:pendingBuildRequest});updatePlacement();
}
function clearBuildingSelection(){
  selectedTowerId=selectedBaseId=selectedNodeId=null;
  towerPanelKey=basePanelKey=nodePanelKey='';
  view.hideTowerRange();
  $('tower-panel').classList.add('hidden');
  $('base-panel').classList.add('hidden');
  $('node-panel').classList.add('hidden');
}
function selectTower(id){
  clearBuildingSelection();selectedTowerId=id;
  setSelection([]);attackTargeting=false;
}
function selectBase(id){
  clearBuildingSelection();selectedBaseId=id;
  setSelection([]);attackTargeting=false;
}
function selectNode(id){
  clearBuildingSelection();selectedNodeId=id;
  setSelection([]);attackTargeting=false;
}
function closeTower(){clearBuildingSelection();}
function upgradeTower(){
  if(!canAct()||selectedTowerId==null)return;
  send({type:'upgrade_tower',towerId:selectedTowerId});
}
function upgradeBase(){
  if(!canAct()||selectedBaseId==null)return;
  send({type:'upgrade_base',baseId:selectedBaseId});
}
function upgradeResource(){
  if(!canAct()||selectedNodeId==null)return;
  send({type:'upgrade_resource',nodeId:selectedNodeId});
}

export async function startGame(report, signal) {
  report(40, '初始化 3D 画面', '检查浏览器图形能力');
  await new Promise(resolve=>setTimeout(resolve,0));signal.throwIfAborted();
  try { view=new ValleyScene($('game')); }
  catch(error){throw new Error('3D 画面初始化失败。请使用支持 WebGL 2 的 Chrome 或 Edge，并检查图形加速设置。详细信息：'+error.message);}
  await view.prepare(report, signal);
  report(92, '连接游戏服务', '地图已绘制，正在建立对局连接');
  await connect(signal);
  signal.throwIfAborted();
  lastFrame=performance.now();requestAnimationFrame(frame);
}

function onServerMessage(event){
  const msg=JSON.parse(event.data);
  if(msg.type==='welcome'){
    faction=msg.faction;
    if(msg.rules)staticRules=msg.rules;
    if(joined&&latest)toast('已重新连接，恢复原阵营');
    return;
  }
  if(msg.type==='session_taken_over'){
    sessionSuperseded=true;joined=false;keys.clear();clearTimeout(reconnectTimer);
    $('connection').textContent='已在其他窗口进入';
    toast('这个领主已在其他窗口进入游戏，本窗口已退出；刷新本页可重新接管');
    return;
  }
  if(msg.type==='join_rejected'){
    joined=false;$('welcome').classList.remove('hidden');
    $('connection').textContent='未能加入';
    toast(msg.error||'无法加入本局');
    return;
  }
  if(msg.type==='action_result'){
    if(msg.action==='begin_build'&&!msg.ok){cancelPlacement();toast(msg.error);}
    if(msg.action==='build_tower'&&msg.requestId===pendingBuildRequest){pendingBuild=false;if(msg.ok){cancelPlacement();toast('已放置工地并扣除 15 金币、30 木材，工人正在前往');}else{pendingBuildRequest=null;toast(msg.error);updatePlacement();}}
    if(msg.action==='cancel_build')toast(msg.ok?`施工已取消，退回 ${msg.gold} 金币、${msg.wood} 木材`:msg.error);
    if(msg.action==='upgrade_tower')toast(msg.ok?`箭塔已升级到 Lv.${msg.level}`:msg.error);
    if(msg.action==='upgrade_base')toast(msg.ok?`基地已升级到 Lv.${msg.level}`:msg.error);
    if(msg.action==='upgrade_resource')toast(msg.ok?`资源点已升级到 Lv.${msg.level}`:msg.error);
    if(msg.action==='order_attack')toast(msg.ok?`${msg.count} 名单位开始追击目标`:msg.error);
    if(msg.action==='order_home')toast(msg.ok?`${msg.count} 名单位返回基地，到达后恢复原本职位`:msg.error);
    if(msg.action==='take_control')toast(msg.ok?`已接管 ${msg.count} 名单位 · 点击地面移动 · H 回家`:msg.error);
    if(msg.action==='order_move')toast(msg.ok?`${msg.count} 名单位前往指定地点，到达后待命`:msg.error);
    if(msg.action==='join_faction')toast(msg.ok?`已并入阵营 ${msg.target} · 共享胜负，本窗口不再直接指挥`:msg.error);
    return;
  }
  if(msg.type!=='state')return;
  if(!msg.rules&&staticRules)msg.rules=staticRules;
  const old=latest;latest=msg;view.sync(msg);
  setSelection([...selectedIds]);
  if(placement&&(msg.matchState==='over'||!msg.bases.some(b=>b.faction===faction)))cancelPlacement();
  if(msg.matchState==='over'&&(selectedTowerId!=null||selectedBaseId!=null||selectedNodeId!=null))clearBuildingSelection();
  if(old?.matchState==='over'&&msg.matchState!=='over'){keys.clear();setSelection([]);endSelectionDrag();clearBuildingSelection();view.focus.set(0,0,0);view.zoom=1;toast('新的战局已经开始');}
  const id=msg.you.possessedUnitId;
  if(id!==previousPossession){
    keys.clear();attackQueued=false;
    if(id!=null){setSelection([id]);endSelectionDrag();attackTargeting=false;}
    if(id!=null){view.yaw=0;view.pitch=.39;toast('已进入 3D 化身 · 右键拖动环视 · Esc 返回俯视');}
    else if(previousPossession!=null)toast(msg.units.some(u=>u.id===previousPossession)?'已返回俯视，单位恢复自动行动':'化身单位已阵亡，已返回俯视');
    previousPossession=id;
  }
  $('result').classList.toggle('hidden',msg.matchState!=='over');
  if(msg.matchState==='over'){$('result-text').textContent=msg.resultText;keys.clear();}
}

function openSocket(retry){
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
  socket=ws;
  ws.onopen=()=>{
    if(retry&&joined){send({type:'join',name:playerName(),clientId});toast('正在恢复上一局…');return;}
    $('connection').textContent='连接就绪';
    if(startupResolve){clearTimeout(startupTimeout);const done=startupResolve;startupResolve=null;startupReject=null;done();}
  };
  ws.onmessage=onServerMessage;
  ws.onclose=()=>{
    if(ws!==socket)return;
    keys.clear();attackQueued=false;
    if(sessionSuperseded){$('connection').textContent='已在其他窗口进入';return;}
    $('connection').textContent='连接已断开';
    if(placement)cancelPlacement();
    if(!joined){
      if(startupReject){clearTimeout(startupTimeout);const fail=startupReject;startupResolve=null;startupReject=null;fail(new Error('游戏连接已断开，请重新加载。'));}
      $('join-button').disabled=true;
      if(!startupSignal?.aborted){
        $('load-stage').textContent='连接已断开';
        $('load-detail').textContent='地图已生成，但与游戏服务的连接断开。请确认服务已运行，再重新加载。';
        $('retry-load').classList.remove('hidden');
      }
      toast('连接断开，请确认服务端已启动，然后刷新页面');
      return;
    }
    toast('连接断开，正在自动重连…');
    clearTimeout(reconnectTimer);
    reconnectTimer=setTimeout(()=>openSocket(true),1200);
  };
  ws.onerror=()=>{
    if(!joined){
      if(startupReject){clearTimeout(startupTimeout);const fail=startupReject;startupResolve=null;startupReject=null;fail(new Error('无法连接游戏服务，请确认终端中的服务仍在运行。'));}
      $('connection').textContent='无法连接';
    }
  };
}

function connect(signal){
  return new Promise((resolve,reject)=>{
    try { $('player-name').value=localStorage.getItem('name')||'河谷旅人'; } catch {}
    startupSignal=signal;startupResolve=resolve;startupReject=reject;
    startupTimeout=setTimeout(()=>{
      const fail=startupReject;startupResolve=null;startupReject=null;
      fail(new Error('连接游戏服务超过 8 秒，请确认服务已启动后重新加载。'));
      socket.close();
    },8000);
    signal.addEventListener('abort',()=>{clearTimeout(startupTimeout);socket.close();reject(new Error('地图加载已取消'));},{once:true});
    openSocket(false);
  });
}

$('join-form').addEventListener('submit',event=>{
  event.preventDefault();if(joined||socket?.readyState!==WebSocket.OPEN)return;
  const name=$('player-name').value.trim()||'河谷旅人';
  try{localStorage.setItem('name',name);}catch{}
  joined=true;send({type:'join',name,clientId});$('welcome').classList.add('hidden');$('connection').textContent='战局进行中';
});
$('overview').onclick=release;$('possess').onclick=()=>possess();
$('upgrade').onclick=upgrade;$('build').onclick=build;
$('cancel-order').onclick=cancelOrder;
$('squad-attack').onclick=targetAttack;$('squad-home').onclick=goHome;
$('cancel-build-placement').onclick=cancelPlacement;
$('confirm-build').onclick=confirmPlacement;
$('tower-upgrade').onclick=upgradeTower;$('tower-close').onclick=closeTower;
$('base-upgrade').onclick=upgradeBase;$('base-close').onclick=clearBuildingSelection;
$('node-upgrade').onclick=upgradeResource;$('node-close').onclick=clearBuildingSelection;
$('construction-list').onclick=event=>{const button=event.target.closest('button[data-site]');if(button)send({type:'cancel_build',siteId:Number(button.dataset.site)});};
$('restart').onclick=()=>send({type:'restart'});
$('roster').onclick=event=>{const b=event.target.closest('button');if(b)chooseUnit(Number(b.dataset.id),event.shiftKey);};
$('roster').ondblclick=event=>{const b=event.target.closest('button');if(b)possess(Number(b.dataset.id));};
window.addEventListener('resize',()=>{aimPointer.x=Math.min(aimPointer.x,innerWidth);aimPointer.y=Math.min(aimPointer.y,innerHeight);view?.resize();});
window.addEventListener('keydown',event=>{
  if(event.target.closest('input,textarea')||!joined)return;
  const k=event.key.toLowerCase();
  if(placement){if(k==='escape'||k==='b'){event.preventDefault();cancelPlacement();}return;}
  if(k==='escape'&&attackTargeting){attackTargeting=false;return;}
  if(k==='escape'&&(selectedTowerId!=null||selectedBaseId!=null||selectedNodeId!=null)){event.preventDefault();clearBuildingSelection();return;}
  if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright',' ','escape'].includes(k))event.preventDefault();
  keys.add(k);if(event.repeat)return;
  if(k===' '&&selected())attackQueued=true;
  if(k==='escape')release();else if(k==='p')possess();else if(k==='u')upgrade();else if(k==='b')build();
  else if(k==='x')cancelOrder();
  else if(k==='h')goHome();
  else if(k==='a'&&!selected())targetAttack();
  else if(k==='o'){send({type:'surrender'});toast('你已退出本局');}
  else if(k==='l'){
    const other=latest?.factions.find(f=>f.id!==faction&&!f.surrendered&&f.alive&&!f.mergedInto);
    if(other){release();send({type:'join_faction',target:other.id});}
    else toast('当前没有可加入的其它阵营');
  }
});
window.addEventListener('keyup',event=>keys.delete(event.key.toLowerCase()));
function stopInput(){keys.clear();attackQueued=false;dragging=false;endSelectionDrag();pointerOnMap=false;if(placement&&!pendingBuild)cancelPlacement();send({type:'control',dx:0,dy:0,attack:false});}
window.addEventListener('blur',stopInput);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopInput();});
const canvas=$('game');
function endSelectionDrag(){selectionDrag=null;$('selection-box').classList.add('hidden');}
function drawSelection(event){
  if(!selectionDrag)return;
  const d=selectionDrag;d.x2=event.clientX;d.y2=event.clientY;
  if(Math.hypot(d.x2-d.x,d.y2-d.y)>6)d.active=true;
  if(!d.active)return;
  const box=$('selection-box');box.classList.remove('hidden');
  Object.assign(box.style,{left:Math.min(d.x,d.x2)+'px',top:Math.min(d.y,d.y2)+'px',width:Math.abs(d.x2-d.x)+'px',height:Math.abs(d.y2-d.y)+'px'});
}
canvas.addEventListener('pointerenter',()=>{pointerOnMap=true;});
canvas.addEventListener('pointerleave',()=>{if(!dragging)pointerOnMap=false;});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{
  if(placement&&e.button===0)return;
  if(e.button===0){dragMoved=false;if(canAct()&&!selected()){selectionDrag={x:e.clientX,y:e.clientY,x2:e.clientX,y2:e.clientY,active:false,additive:e.shiftKey};canvas.setPointerCapture(e.pointerId);}}
  if(e.button===2){dragging=true;dragMoved=false;dragOrigin={x:e.clientX,y:e.clientY};lastPointer=dragOrigin;canvas.setPointerCapture(e.pointerId);}
});
canvas.addEventListener('pointermove',e=>{
  aimPointer={x:Math.max(0,Math.min(innerWidth,e.clientX)),y:Math.max(0,Math.min(innerHeight,e.clientY))};pointerOnMap=true;
  if(placement&&!dragging){if(!placement.locked&&!e.buttons)movePlacement(e);return;}
  if(selectionDrag){drawSelection(e);return;}
  if(!dragging||!view)return;
  const dx=e.clientX-lastPointer.x,dy=e.clientY-lastPointer.y;lastPointer={x:e.clientX,y:e.clientY};
  if(Math.hypot(e.clientX-dragOrigin.x,e.clientY-dragOrigin.y)>4)dragMoved=true;
  if(!dragMoved)return;
  if(selected()){view.yaw-=dx*.006;view.pitch=Math.max(.14,Math.min(1.05,view.pitch+dy*.005));}
  else{view.focus.x=Math.max(-35,Math.min(35,view.focus.x-dx*.09*view.zoom));view.focus.z=Math.max(-35,Math.min(35,view.focus.z-dy*.13*view.zoom));}
});
canvas.addEventListener('pointerup',e=>{
  if(e.button===0&&selectionDrag){
    drawSelection(e);const d=selectionDrag;
    if(d.active){const ids=view.unitsInRectangle(d.x,d.y,d.x2,d.y2,faction);setSelection(d.additive?[...selectedIds,...ids]:ids);takeControl();attackTargeting=false;suppressClickUntil=performance.now()+250;}
    endSelectionDrag();
  }
  if(placement&&e.button===0){if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);return;}
  if(e.button===2){if(!dragMoved&&!selected()&&!placement)commandAttack(view.pickEnemy(e.clientX,e.clientY,faction));dragging=false;}
  if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointercancel',()=>{dragging=false;endSelectionDrag();});
canvas.addEventListener('click',e=>{
  if(performance.now()<suppressClickUntil)return;
  if(placement){if(e.detail===1)movePlacement(e,true);return;}
  if(!canAct()||dragMoved){dragMoved=false;return;}
  const target=view.pickEnemy(e.clientX,e.clientY,faction);
  if(attackTargeting){if(target)commandAttack(target);else toast('请选择敌方单位或建筑');return;}
  const tower=selected()?null:view.pickTower(e.clientX,e.clientY,faction);
  if(tower){selectTower(tower.id);return;}
  const base=selected()?null:view.pickBase(e.clientX,e.clientY,faction);
  if(base){selectBase(base.id);return;}
  const node=selected()?null:view.pickNode(e.clientX,e.clientY);
  if(node){selectNode(node.id);return;}
  const id=view.pick(e.clientX,e.clientY,faction);
  if(id!=null)chooseUnit(id,e.shiftKey);else if(selectedTowerId!=null||selectedBaseId!=null||selectedNodeId!=null)clearBuildingSelection();else if(!selected()){if(target)commandAttack(target);else commandMove(e.clientX,e.clientY);}
});
canvas.addEventListener('dblclick',e=>{if(!canAct()||performance.now()<suppressClickUntil)return;if(placement){confirmPlacement();return;}const id=view.pick(e.clientX,e.clientY,faction);if(id!=null)possess(id);});
canvas.addEventListener('wheel',e=>{
  e.preventDefault();if(!view)return;
  if(selected())view.distance=Math.max(5,Math.min(20,view.distance+e.deltaY*.008));
  else view.zoom=Math.max(.48,Math.min(1.5,view.zoom+e.deltaY*.0006));
},{passive:false});
$('minimap').addEventListener('click',e=>{
  if(selected())release();
  const rect=e.currentTarget.getBoundingClientRect();
  view.focus.set((e.clientX-rect.left)/rect.width*108-54,0,(e.clientY-rect.top)/rect.height*108-54);
  view.zoom=.62;
});

function control(now){
  if(!canAct()||!selected()||now-lastSend<50)return;
  lastSend=now;
  const f=Number(keys.has('w')||keys.has('arrowup'))-Number(keys.has('s')||keys.has('arrowdown'));
  const r=Number(keys.has('d')||keys.has('arrowright'))-Number(keys.has('a')||keys.has('arrowleft'));
  // Move relative to the horizontal camera heading, including after orbiting.
  const dx=r*Math.cos(view.yaw)-f*Math.sin(view.yaw),dy=-r*Math.sin(view.yaw)-f*Math.cos(view.yaw);
  const aim=view.aim(selected(),aimPointer.x,aimPointer.y);
  send({type:'control',dx,dy,attack:pointerOnMap&&(keys.has(' ')||attackQueued),aimX:aim.dx,aimY:aim.dy});attackQueued=false;
}

function hud(){
  if(!latest)return;
  const you=latest.you,u=selected(),own=latest.units.filter(x=>x.faction===faction);
  const commanded=own.find(x=>x.id===commandId);
  const squad=own.filter(x=>selectedIds.has(x.id));
  updatePlacement();
  $('connection').textContent=socket.readyState!==WebSocket.OPEN?'连接已断开':latest.matchState==='over'?'战局已结束':you.surrendered?'已退出战局':'战局进行中';
  for(const resource of ['gold','food','wood','ore'])$(resource).textContent=Math.floor(you.resources[resource]);
  const secs=Math.ceil(latest.timeLeft);$('timer').textContent=String(Math.floor(secs/60)).padStart(2,'0')+':'+String(secs%60).padStart(2,'0');
  $('view-title').textContent=u?'亲临战场':'领主视野';
  $('view-help').textContent=you.mergedInto?`已并入阵营 ${you.mergedInto} · 共享胜负，本窗口不再直接指挥`:u?`正在控制${names[u.type]} · 生命 ${Math.ceil(u.hp)} / ${u.maxHp} · 攻击 ${u.attack}`:attackTargeting?'点击敌方目标，让选中的部队集中攻击':squad.length?`选中 ${squad.length} 名单位 · 点击地面移动，点击敌人攻击`:'单击单位接管 · 左键拖动框选 · 双击或 P 化身';
  $('overview').classList.toggle('active',!u);$('possess').classList.toggle('active',!!u);
  $('controls').innerHTML=u?'鼠标移动瞄准 · 空格攻击<br>右键转镜头 · <strong>Esc</strong> 返回俯视':'单击接管 · 点击地面移动 · 左键框选<br><strong>H</strong> 回家 · P 化身 · X 自动行动';
  $('unit-count').textContent=own.length+' / 8';
  const returning=squad.filter(x=>x.order?.kind==='home').length;
  $('unit-detail').textContent=u?`${names[u.type]}化身中 · 攻击 +20% · 生命 +20%`:returning?`${returning} 名单位回家中 · 到达后恢复原本职位`:squad.some(x=>x.order?.kind==='move')?'正在前往指定地点 · 到达后待命':squad.length>1?names.map((name,type)=>`${name} ${squad.filter(x=>x.type===type).length}`).join(' · '):commanded?.buildSiteId!=null?'工人执行施工任务中':commanded?.order?'正在执行攻击指令 · X 自动行动':commanded?.commanded?'已接管，原地待命 · 点击地面移动':commanded?'自动行动中 · 点击地面下达移动指令':'工人自动采集 · 基地自动生产';
  $('selection-count').textContent=`选中 ${squad.length}`;
  $('squad-attack').disabled=!squad.length||!!u||!!placement;
  $('squad-home').disabled=!squad.length||!!u||!!placement||!latest.bases.some(b=>b.faction===faction);
  $('squad-attack').classList.toggle('active',attackTargeting);canvas.style.cursor=attackTargeting?'crosshair':'';
  $('cancel-order').disabled=!squad.some(x=>x.order||x.commanded)||!!u;
  $('upgrade-cost').textContent=you.upgradeLevel>=5?'已满级':`${you.upgradeLevel*50} 金 · 20 矿 / Lv.${you.upgradeLevel}`;
  const rk=own.map(x=>`${x.id}:${x.type}:${Math.ceil(x.hp)}:${selectedIds.has(x.id)}`).join('|');
  if(rk!==rosterKey){
    rosterKey=rk;$('roster').replaceChildren();
    for(const unit of own){const b=document.createElement('button');b.dataset.id=unit.id;b.textContent=names[unit.type];b.title=`选择${names[unit.type]}（Shift 多选，双击化身）· 生命 ${Math.ceil(unit.hp)}/${unit.maxHp}`;b.classList.toggle('selected',selectedIds.has(unit.id));const h=document.createElement('i');h.style.width=unit.hp/unit.maxHp*100+'%';b.append(h);$('roster').append(b);}
  }
  const ranked=[...latest.factions].sort((a,b)=>b.score-a.score);
  const nk=JSON.stringify(ranked);
  if(nk!==ranksKey){
    ranksKey=nk;$('ranks').replaceChildren();
    for(const f of ranked){const row=document.createElement('div');row.className='rank';const dot=document.createElement('i');dot.style.background=factionColor(f.id);const name=document.createElement('span');name.textContent=f.name+(f.id===faction?' · 你':'')+(f.surrendered?' · 已退出':'');const score=document.createElement('b');score.textContent=f.score;row.append(dot,name,score);$('ranks').append(row);}
  }
  drawMinimap();
  const sites=(latest.sites||[]).filter(s=>s.faction===faction);
  const sk=sites.map(s=>`${s.id}:${s.status}:${Math.floor(s.progress*10)}`).join('|');
  if(sk!==sitesKey){
    sitesKey=sk;$('construction-list').replaceChildren();
    for(const site of sites){
      const row=document.createElement('div');row.className='construction-row';
      const text=document.createElement('span');text.textContent=`箭塔 · ${site.status==='travel'?'工人赶路':site.status==='waiting'?'暂停，等待工人':`施工 ${Math.floor(site.progress/site.duration*100)}% · 剩 ${Math.ceil(site.duration-site.progress)}秒`}`;
      const progress=document.createElement('progress');progress.max=site.duration;progress.value=site.progress;
      const button=document.createElement('button');button.dataset.site=site.id;button.textContent='取消';button.title='取消施工，按未完成比例退还资源';
      row.append(text,button,progress);$('construction-list').append(row);
    }
  }
  const tower=selectedTowerId!=null?latest.towers.find(t=>t.id===selectedTowerId&&t.faction===faction):null;
  if(!tower){
    if(selectedTowerId!=null)closeTower();
  }else{
    const rules=latest.rules||{},maxLv=rules.towerMaxLevel||5;
    const key=`${tower.id}:${tower.level}:${Math.ceil(tower.hp)}:${tower.maxHp}`;
    if(key!==towerPanelKey){
      towerPanelKey=key;
      $('tower-panel').classList.remove('hidden');
      $('tower-level').textContent=`Lv.${tower.level} / ${maxLv}`;
      $('tower-stats').textContent=`生命 ${Math.ceil(tower.hp)} / ${tower.maxHp} · 攻击 ${Math.round(tower.attack*10)/10} · 射程 ${tower.range}`;
      const upgraded=tower.level>=maxLv;
      const gold=(rules.towerUpgradeCostGold||10)*tower.level,wood=(rules.towerUpgradeCostWood||20)*tower.level;
      $('tower-upgrade').disabled=upgraded||!canAct();
      $('tower-upgrade').textContent=upgraded?'已满级':`升级到 Lv.${tower.level+1}`;
      $('tower-upgrade-cost').textContent=upgraded?`每级 +攻击 ${Math.round((rules.towerUpgradeAttackBonus||.25)*100)}% · +生命 ${Math.round((rules.towerUpgradeHpBonus||.25)*100)}% · +射程 ${rules.towerUpgradeRangeBonus||.5}`:`消耗 ${gold} 金币 · ${wood} 木材`;
    }
    view.showTowerRange(tower);
  }
  const base=selectedBaseId!=null?latest.bases.find(b=>b.id===selectedBaseId&&b.faction===faction):null;
  if(!base){
    if(selectedBaseId!=null)clearBuildingSelection();
  }else{
    const rules=latest.rules||{},maxLv=rules.baseMaxLevel||5;
    const key=`${base.id}:${base.level}:${Math.ceil(base.hp)}:${base.maxHp}`;
    if(key!==basePanelKey){
      basePanelKey=key;
      $('base-panel').classList.remove('hidden');
      $('base-level').textContent=`Lv.${base.level} / ${maxLv}`;
      $('base-stats').textContent=`生命 ${Math.ceil(base.hp)} / ${base.maxHp} · 出兵 ${(base.spawnInterval??8).toFixed(1)} 秒/个`;
      const upgraded=base.level>=maxLv;
      const gold=(rules.baseUpgradeCostGold||30)*base.level,ore=(rules.baseUpgradeCostOre||15)*base.level;
      $('base-upgrade').disabled=upgraded||!canAct();
      $('base-upgrade').textContent=upgraded?'已满级':`升级到 Lv.${base.level+1}`;
      $('base-upgrade-cost').textContent=upgraded?`每级 +生命 ${Math.round((rules.baseUpgradeHpBonus||.25)*100)}% · 出兵提速 ${Math.round((rules.baseSpawnSpeedBonus||.12)*100)}%`:`消耗 ${gold} 金币 · ${ore} 矿石`;
    }
  }
  const node=selectedNodeId!=null?latest.nodes.find(n=>n.id===selectedNodeId):null;
  if(!node){
    if(selectedNodeId!=null)clearBuildingSelection();
  }else{
    const rules=latest.rules||{},maxLv=rules.resourceMaxLevel||5;
    const typeName=['金矿','农田','林地','铁矿'][node.type]||'资源';
    const ownerName=node.owner>=0?(latest.factions.find(f=>f.id===node.owner)?.name||('阵营 '+node.owner)):'未占领';
    const mine=node.owner===faction;
    const ownBase=latest.bases.filter(b=>b.faction===faction).reduce((best,b)=>!best||b.level>best.level?b:best,null);
    const key=`${node.id}:${node.level}:${node.owner}:${Math.floor(node.amount)}:${node.maxAmount}:${ownBase?.level||0}:${canAct()}`;
    if(key!==nodePanelKey){
      nodePanelKey=key;
      $('node-panel').classList.remove('hidden');
      $('node-level').textContent=`Lv.${node.level} / ${maxLv}`;
      $('node-stats').textContent=`${typeName} · 归属 ${ownerName} · 储量 ${Math.floor(node.amount)} / ${node.maxAmount}`;
      const upgraded=node.level>=maxLv;
      const lockedByBase=mine&&!upgraded&&(!ownBase||node.level>=ownBase.level);
      const gold=(rules.resourceUpgradeCostGold||8)*node.level,wood=(rules.resourceUpgradeCostWood||10)*node.level;
      $('node-upgrade').disabled=upgraded||!mine||!canAct()||!!lockedByBase;
      $('node-upgrade').textContent=upgraded?'已满级':`升级到 Lv.${node.level+1}`;
      $('node-upgrade-cost').textContent=!mine?'该资源点不属于己方阵营':upgraded?`每级 +产量 ${Math.round((rules.resourceYieldBonus||.25)*100)}% · +储量`:lockedByBase?`需要基地达到 Lv.${node.level+1} 才能升级`:`消耗 ${gold} 金币 · ${wood} 木材`;
    }
  }
}

function drawMinimap(){
  const c=$('minimap'),ctx=c.getContext('2d'),W=globalThis.World;
  ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#829c6a';ctx.fillRect(0,0,c.width,c.height);
  const point=(x,z)=>[(x+54)/108*c.width,(z+54)/108*c.height];
  for(const r of W.regions){const [x,z]=point(r.x,r.y);ctx.fillStyle=['#bcaa78','#b5b66c','#426d4a','#9aaba0'][r.type];ctx.beginPath();ctx.ellipse(x,z,r.radius/108*c.width,r.radius/108*c.height,0,0,Math.PI*2);ctx.fill();}
  ctx.strokeStyle='#80bcc5';ctx.lineWidth=7;ctx.beginPath();for(let z=-54;z<=54;z++){const [x,y]=point(W.riverX(z),z);if(z===-54)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();
  for(const z of W.bridges){const p=point(W.riverX(z),z);ctx.fillStyle='#d9c69a';ctx.fillRect(p[0]-7,p[1]-2,14,4);}
  for(const n of latest.nodes){const p=point(n.x,n.y);ctx.fillStyle='#f0dca0';ctx.fillRect(p[0]-1,p[1]-1,2,2);}
  for(const b of latest.bases){const p=point(b.x,b.y);ctx.fillStyle=factionColor(b.faction);ctx.strokeStyle='#20392a';ctx.fillRect(p[0]-4,p[1]-4,8,8);ctx.strokeRect(p[0]-4,p[1]-4,8,8);}
  for(const s of latest.sites||[]){const p=point(s.x,s.y);ctx.strokeStyle='#f8d48c';ctx.lineWidth=1;ctx.strokeRect(p[0]-3,p[1]-3,6,6);}
  for(const u of latest.units){const p=point(u.x,u.y);ctx.fillStyle=factionColor(u.faction);ctx.beginPath();ctx.arc(p[0],p[1],u.possessed?3.2:1.8,0,Math.PI*2);ctx.fill();if(u.possessed){ctx.strokeStyle='#fff2b0';ctx.lineWidth=1;ctx.stroke();}}
  const target=selected(),p=point(target?.x??view.focus.x,target?.y??view.focus.z);
  ctx.strokeStyle='#f4ebbd';ctx.lineWidth=1;
  if(target){ctx.beginPath();ctx.arc(p[0],p[1],7,0,Math.PI*2);ctx.stroke();}
  else ctx.strokeRect(p[0]-35*view.zoom,p[1]-24*view.zoom,70*view.zoom,48*view.zoom);
}

function frame(now){
  requestAnimationFrame(frame);
  const dt=Math.min((now-lastFrame)/1000,.08);lastFrame=now;
  if(placement&&!pendingBuild&&now-previewHeartbeat>3000){send({type:latest?.you.buildBudgetProtected?'build_preview_keepalive':'begin_build'});previewHeartbeat=now;}
  control(now);view.render(dt,now/1000);
  updateReticle();
  if(now-lastHud>140){hud();lastHud=now;}
}

function updateReticle(){
  const u=selected(),active=canAct()&&!!u&&pointerOnMap;
  $('aim-hud').classList.toggle('hidden',!active);if(!active)return;
  $('aim-hud').style.left=aimPointer.x+'px';$('aim-hud').style.top=aimPointer.y+'px';
  const aim=view.aim(u,aimPointer.x,aimPointer.y),age=(latest.time||0)+Math.min((performance.now()-view.receivedAt)/1000,.15)-u.attackStartedAt;
  const drawing=u.type===2&&age>=0&&age<.38;
  $('reticle').classList.toggle('locked',!!aim.inRange);$('reticle').classList.toggle('drawing',drawing);
  $('aim-text').textContent=drawing?'拉弓蓄力…':u.type===2&&age>=.38&&age<u.attackSpeed?'箭已射出 · 准备下一箭':aim.enemy?aim.inRange?'目标在射程内 · 空格攻击':'目标超出射程':u.type===2?'鼠标瞄准 · 空格拉弓射击':'鼠标瞄准 · 空格挥击';
  $('attack-charge').value=drawing?age/.38:Math.min(1,Math.max(0,age/u.attackSpeed));
}
