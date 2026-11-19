'use strict';
// Execute real input handlers with a small DOM/transport adapter; GPU rendering is tested separately.
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
  const elements=new Map(),messages=[];
  function element(id){
    if(!elements.has(id))elements.set(id,{value:'测试',style:{},events:{},classList:{add(){},remove(){},toggle(){}},
      dataset:{},append(){},replaceChildren(){},getContext(){return drawing;},
      addEventListener(name,fn){this.events[name]=fn;},setPointerCapture(){},hasPointerCapture(){return false;}});
    return elements.get(id);
  }
  const drawing=new Proxy({}, {get:()=>()=>{}});
  let scene,ws;
  class Scene{
    constructor(){scene=this;this.focus={set(){}};}
    async prepare(){} sync(state){this.state=state;}
    pick(x){return x===10?1:null;}
    pickTower(){return null;} pickBase(){return null;} pickNode(){return null;} hideTowerRange(){}
    pickEnemy(x){return x===90?{kind:'unit',id:3}:null;}
    groundPoint(x,y){return {x:x/10,y:y/10};}
    movementPoint(x,y){return x===70?{error:'障碍物上不能设置目的地'}:this.groundPoint(x,y);}
    showMoveFlag(x,y){this.flag={x,y};}
    unitsInRectangle(){return [1,2];}
  }
  class Socket{
    static OPEN=1;
    constructor(){ws=this;this.readyState=1;setTimeout(()=>this.onopen(),0);}
    send(data){messages.push(JSON.parse(data));} close(){}
  }
  const context=vm.createContext({World:{regions:[],bridges:[],riverX:()=>0},document:{getElementById:element,createElement:()=>element(Symbol()),addEventListener(){}},window:{addEventListener(){}},
    innerWidth:1280,innerHeight:800,performance:{now:()=>1000},setTimeout,clearTimeout,requestAnimationFrame(){},
    WebSocket:Socket,location:{protocol:'http:',host:'test'},localStorage:{getItem(){},setItem(){}}});
  const module=new vm.SourceTextModule(fs.readFileSync(path.join(__dirname,'../client/game.js'),'utf8')+'\nexport { hud as testHud, selectNode as testSelectNode };',{context});
  const dependency=new vm.SyntheticModule(['ValleyScene','factionColor'],function(){this.setExport('ValleyScene',Scene);this.setExport('factionColor',()=> '#fff');},{context});
  await module.link(()=>dependency);await module.evaluate();
  await module.namespace.startGame(()=>{},new AbortController().signal);
  const receive=data=>ws.onmessage({data:JSON.stringify(data)});
  receive({type:'welcome',faction:1});
  const state={type:'state',matchState:'running',you:{possessedUnitId:null},units:[{id:1,faction:1},{id:2,faction:1},{id:3,faction:2}],bases:[]};
  receive(state);element('join-form').events.submit({preventDefault(){}});messages.length=0;
  const canvas=element('game');
  const click=(x,y)=>canvas.events.click({clientX:x,clientY:y,detail:1});
  click(10,20);assert.deepEqual(messages.pop(),{type:'take_control',unitIds:[1]});
  click(30,40);assert.deepEqual(messages.pop(),{type:'order_move',unitIds:[1],x:3,y:4});
  click(50,60);assert.deepEqual(messages.pop(),{type:'order_move',unitIds:[1],x:5,y:6});
  assert.deepEqual(scene.flag,{x:5,y:6});
  click(70,60);assert.equal(messages.length,0);assert.deepEqual(scene.flag,{x:5,y:6});
  assert.equal(scene.commandId,1);assert.equal(messages.length,0);
  receive(state);assert.equal(messages.length,0); // snapshots must never reset orders
  click(90,10);assert.deepEqual(messages.pop(),{type:'order_attack',unitIds:[1],targetId:3,targetKind:'unit'});
  element('squad-home').onclick();assert.deepEqual(messages.pop(),{type:'order_home',unitIds:[1]});
  element('cancel-order').onclick();assert.deepEqual(messages.pop(),{type:'cancel_order',unitIds:[1]});
  canvas.events.pointerdown({button:0,clientX:20,clientY:20,pointerId:1});
  canvas.events.pointerup({button:0,clientX:100,clientY:100,pointerId:1});
  assert.deepEqual(messages.pop(),{type:'take_control',unitIds:[1,2]});
  assert.equal(scene.selectedIds.size,2);
  const panelState={...state,units:[],timeLeft:600,towers:[],factions:[{id:1,name:'A',score:0}],
    you:{...state.you,resources:{gold:30,food:50,wood:30,ore:20},upgradeLevel:1},
    nodes:[{id:50,type:0,owner:1,level:1,amount:100,maxAmount:100,x:0,y:0}],
    bases:[{id:10,faction:1,level:1,x:0,y:0}]};
  receive(panelState);module.namespace.testSelectNode(50);module.namespace.testHud();
  assert.equal(element('node-upgrade').disabled,true);
  panelState.bases.push({id:11,faction:1,level:2,x:10,y:10});
  receive(panelState);module.namespace.testHud();assert.equal(element('node-upgrade').disabled,false);
  panelState.bases[1].faction=2;
  receive(panelState);module.namespace.testHud();assert.equal(element('node-upgrade').disabled,true);
  panelState.bases=[];
  receive(panelState);module.namespace.testHud();assert.equal(element('node-upgrade').disabled,true);
  console.log('PASS Resource panel reacts to highest base level and losing bases without node changes');
  console.log('✓ 真实客户端输入：单击接管、连续点击移动、坐标映射、攻击、回家、解除接管、框选；状态刷新不重置指令');
})().catch(error=>{console.error(error);process.exitCode=1;});
