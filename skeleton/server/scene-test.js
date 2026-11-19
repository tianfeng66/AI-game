'use strict';
// CPU scene-graph checks use actual Three.js geometry and matrices; no claim of GPU visual QA.
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
  const THREE=await import(pathToFileURL(path.join(__dirname,'../node_modules/three/build/three.module.js')).href);
  class Renderer {
    constructor(){this.shadowMap={};}
    setPixelRatio(){} setSize(){} compileAsync(){return Promise.resolve();}
    render(scene,camera){scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);}
  }
  const nodes=[];
  const el=()=>({style:{},append(){},remove(){this.removed=true;}});
  let now=1000;
  const context=vm.createContext({World:require('../client/world'),devicePixelRatio:1,innerWidth:1280,innerHeight:800,performance:{now:()=>now},setTimeout,requestAnimationFrame:fn=>setTimeout(fn,0),
    document:{createElement:el,createTextNode:t=>({textContent:t}),getElementById:()=>({append:e=>nodes.push(e)})}});
  const module=new vm.SourceTextModule(fs.readFileSync(path.join(__dirname,'../client/scene.js'),'utf8'),{context});
  const exports=Object.keys(THREE);
  const threeModule=new vm.SyntheticModule(exports,function(){for(const key of exports)this.setExport(key,key==='WebGLRenderer'?Renderer:THREE[key]);},{context});
  await module.link(()=>threeModule);await module.evaluate();
  const view=new module.namespace.ValleyScene({});
  await view.prepare(()=>{},new AbortController().signal);
  assert.ok(view.scene.children.length>80);assert.equal(view.labels.length,8);
  const baseUnit={id:1,type:1,faction:1,x:0,y:0,hp:180,maxHp:180,possessed:true,attackStartedAt:10,aimX:0,aimY:-1,attackAimX:0,attackAimY:-1,attackSeq:1};
  const archer={...baseUnit,id:2,type:2,x:3,hp:84,maxHp:84,possessed:false};
  const state={time:10.2,you:{possessedUnitId:1},units:[baseUnit,archer],bases:[],towers:[],nodes:[],projectiles:[]};
  view.sync(state);view.render(.05,1);
  const warrior=view.units.get(1),bow=view.units.get(2);
  assert.equal(warrior.userData.slash.visible,true);
  assert.ok(warrior.userData.limbs[3].rotation.x<0);
  assert.ok(bow.userData.string.geometry.attributes.position.getZ(1)<-.2);
  assert.equal(bow.userData.nocked.visible,true);
  console.log('✓ 真实场景几何：近战挥击、刀光、弓弦拉伸与搭箭姿态均按前摇更新');
  view.sync({...state,time:10.5,projectiles:[{id:99,x:2,y:-2,dx:0,dy:-1,faction:1}]});view.render(.05,1.3);
  assert.equal(bow.userData.nocked.visible,false);assert.equal(view.arrows.size,1);
  view.sync({...state,time:11,projectiles:[]});view.render(.05,1.8);
  assert.equal(warrior.userData.slash.visible,false);assert.equal(view.arrows.size,0);
  console.log('✓ 放箭后弓上箭隐藏、飞行箭模型出现；动作与箭矢结束后正确回收');
  const enemy={...baseUnit,id:3,faction:2,possessed:false,x:0,y:-7,order:null};
  view.sync({...state,time:11,you:{possessedUnitId:null},units:[{...baseUnit,possessed:false,order:{kind:'unit',id:3}},enemy]});view.commandId=1;view.render(.05,2);
  assert.equal(view.orderMarker.visible,true);assert.equal(view.orderMarker.position.z,-7);
  view.camera.position.set(0,4,12);view.camera.lookAt(0,1.25,-7);view.camera.updateMatrixWorld(true);view.scene.updateMatrixWorld(true);
  const aim=view.aim({...baseUnit,range:18});assert.equal(aim.enemy.id,3);assert.equal(aim.inRange,true);assert.ok(aim.dy<-.99);
  console.log('✓ 俯视攻击目标圈与实际目标一致；准心射线解析出前方敌人及正确发射方向');
  const leftAim=view.aim({...baseUnit,range:18},320,400),rightAim=view.aim({...baseUnit,range:18},960,400);
  assert.ok(leftAim.dx<-.1);assert.ok(rightAim.dx>.1);
  console.log('✓ 左右移动鼠标坐标会改变实际射线与攻击方向，不再固定屏幕中央');
  view.state={...view.state,bases:[{id:800,x:-34,y:17,faction:1},{id:801,x:34,y:-20,faction:2}]};
  view.showBuildPreview(-26,17,true,1);assert.equal(view.buildPreview.position.x,-26);
  assert.equal(view.buildRanges.children.length,3);
  const radiusLine=view.buildRanges.children[2].geometry.attributes.position;
  assert.ok(Math.abs(Math.hypot(radiusLine.getX(0)+34,radiusLine.getZ(0)-17)-18)<.001);
  assert.equal(view.buildPreview.children[0].material.transparent,true);
  view.showBuildPreview(0,0,false,1);assert.equal(view.buildPreview.children[0].material.color.getHexString(),'ef9276');
  view.hideBuildPreview();assert.equal(view.buildPreview,null);
  assert.equal(view.buildRanges,null);
  const site={id:500,faction:1,x:-26,y:17,hp:100,maxHp:100,progress:6,duration:12,status:'building',workerId:4};
  view.sync({...state,you:{possessedUnitId:null},units:[{...baseUnit,id:4,type:0,x:-25,y:17,possessed:false,buildSiteId:500}],sites:[site]});view.render(.05,2);
  const construction=view.sites.get(500);assert.equal(construction.userData.fill.scale.x,.5);assert.ok(Math.abs(construction.userData.model.scale.y-.575)<1e-9);
  assert.match(construction.userData.label.textContent,/50%/);const label=construction.userData.label;
  view.sync({...state,sites:[]});assert.equal(view.sites.size,0);assert.equal(label.removed,true);
  console.log('✓ 建塔预览随位置移动并变色，工地模型、进度条和剩余时间正确，完工后清理标签');
  view.sync({...state,you:{possessedUnitId:null},units:[{...baseUnit,possessed:false},archer,enemy]});
  view.camera.position.set(0,40,20);view.camera.lookAt(0,0,0);view.camera.updateMatrixWorld(true);view.scene.updateMatrixWorld(true);
  assert.deepEqual(Array.from(view.unitsInRectangle(0,0,1280,800,1)).sort(),[1,2]);
  assert.deepEqual(Array.from(view.unitsInRectangle(1280,800,0,0,1)).sort(),[1,2]);
  const p=view.units.get(1).position.clone().add(new THREE.Vector3(0,1,0)).project(view.camera),px=(p.x+1)*640,py=(1-p.y)*400;
  assert.deepEqual(Array.from(view.unitsInRectangle(px-3,py-3,px+3,py+3,1)),[1]);
  view.selectedIds=new Set([1,2]);view.render(.05,3);
  assert.equal(view.units.get(1).userData.ring.material.color.getHexString(),'ffe39a');assert.equal(view.units.get(2).userData.ring.material.color.getHexString(),'ffe39a');
  console.log('✓ 正反方向框选都只选择框内己方单位，多单位选中圈同时显示');
  view.commandId=1;
  view.showMoveFlag(8,12);
  view.sync({...state,you:{possessedUnitId:null},units:[{...baseUnit,possessed:false,order:{kind:'move',x:8,y:12}}]});view.render(.05,4);
  assert.equal(view.moveFlag.visible,true);assert.equal(view.moveFlag.position.x,8);assert.equal(view.moveFlag.position.z,12);
  assert.equal(view.moveFlag.children[1].material.color.getHexString(),'ef3f3f');assert.equal(view.orderMarker.visible,false);
  now=1999;view.render(.05,4.01);assert.equal(view.moveFlag.visible,true);
  now=2000;view.render(.05,4.02);assert.equal(view.moveFlag.visible,false);
  view.sync({...state,you:{possessedUnitId:null},units:[{...baseUnit,possessed:false,order:{kind:'move',x:8,y:12}}]});view.render(.05,4.03);
  assert.equal(view.moveFlag.visible,false); // snapshots cannot restart the click timer
  view.showMoveFlag(-6,5);
  view.sync({...state,you:{possessedUnitId:null},units:[{...baseUnit,possessed:false,order:{kind:'move',x:-6,y:5}}]});view.render(.05,4.05);
  assert.equal(view.moveFlag.position.x,-6);assert.equal(view.moveFlag.position.z,5);
  view.sync({...state,you:{possessedUnitId:null},units:[{...baseUnit,possessed:false,order:null}]});view.render(.05,4.1);
  assert.equal(view.moveFlag.visible,true); // arriving early does not shorten the one-second feedback
  now=3000;view.render(.05,4.2);assert.equal(view.moveFlag.visible,false);
  console.log('✓ 红旗点击后显示 1 秒，快到达不提前消失，状态同步不重置计时，新点击重新计时');
  view.camera.position.set(-34,40,35);view.camera.lookAt(-34,0,17);view.camera.updateMatrixWorld(true);view.scene.updateMatrixWorld(true);
  const world=require('../client/world'),tree=world.scenery().trees[0];
  const screen=(x,y,z)=>{const p=new THREE.Vector3(x,y,z).project(view.camera);return [(p.x+1)*640,(1-p.y)*400];};
  const treePixel=screen(tree.x,world.height(tree.x,tree.y)+tree.size*3,tree.y);
  assert.ok(view.movementPoint(...treePixel).error);
  assert.ok(view.movementPoint(...screen(51,world.height(51,17),17)).error);
  const open=view.movementPoint(...screen(-30,world.height(-30,17),17));assert.equal(open.error,undefined);
  console.log('✓ 真实鼠标射线拒绝树冠与越界地点，空地仍可点击');
})().catch(error=>{console.error(error);process.exitCode=1;});
