import * as THREE from '/vendor/three.module.js';

const W = globalThis.World;
export const factionColor = id => ['#da8968', '#82c8d6', '#b2cc7e', '#d5b36f', '#bd9bcb'][id % 5];
const mats = new Map();
function mat(color) {
  if (!mats.has(color)) mats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true }));
  return mats.get(color);
}
const geometries = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cone: new THREE.ConeGeometry(1, 1, 6),
  rock: new THREE.IcosahedronGeometry(1, 0),
  cylinder: new THREE.CylinderGeometry(1, 1, 1, 7),
  sphere: new THREE.SphereGeometry(1, 10, 8),
};
function mesh(parent, shape, color, x, y, z, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(geometries[shape], mat(color));
  m.position.set(x, y, z); m.scale.set(sx, sy, sz);
  m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}

export class ValleyScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#b9d0cb');
    this.scene.fog = new THREE.Fog('#b9d0cb', 100, 220);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 350);
    this.camera.position.set(0, 103, 66);
    this.look = new THREE.Vector3();
    this.focus = new THREE.Vector3(0, 0, 0);
    this.zoom = 1;
    this.yaw = 0;
    this.pitch = 0.39;
    this.distance = 12;
    this.units = new Map(); this.bases = new Map(); this.towers = new Map(); this.nodes = new Map();this.arrows=new Map();this.sites=new Map();
    this.buildPreview=null;
    this.buildRanges=null;this.buildRangesKey='';
    this.towerRange=null;this.towerRangeKey='';
    this.commandId=null;this.damageLabels=[];
    this.selectedIds=new Set();
    this.labels = []; this.windmills = [];
    this.raycaster = new THREE.Raycaster();
    this.scene.add(new THREE.HemisphereLight('#fff3d7', '#62775a', 2.5));
    this.sun = new THREE.DirectionalLight('#ffe3ae', 3.1);
    this.sun.position.set(-35, 70, 25);
    this.sun.castShadow = true;
    Object.assign(this.sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: 1, far: 180 });
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.orderMarker=new THREE.Mesh(new THREE.RingGeometry(1.7,1.85,40),new THREE.MeshBasicMaterial({color:'#ffb18c',side:THREE.DoubleSide,depthWrite:false}));
    this.orderMarker.rotation.x=-Math.PI/2;this.orderMarker.visible=false;this.scene.add(this.orderMarker);
    this.moveFlag=this.makeMoveFlag();this.moveFlagUntil=0;this.movementBlockers=[];this.scene.add(this.moveFlag);
    this.resize();
    this.camera.lookAt(this.look);
  }

  async prepare(report, signal) {
    // Yield between completed phases so the browser can paint progress updates.
    const paint = async () => { await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))); signal.throwIfAborted(); };
    report(50, '生成河谷地形', '构建地表、河道、道路和木桥');
    await paint(); this.makeTerrain();
    report(65, '布置森林与矿场', '生成树木、矿洞、农田和风车');
    await paint(); this.makeLandscape();
    report(80, '准备地图画面', '首次绘制需要编译图形效果，低性能设备可能稍慢');
    await paint();
    await this.renderer.compileAsync(this.scene, this.camera);
    signal.throwIfAborted();
    this.render(0, 0);
    await paint();
  }

  ground(x, z) { return W.height(x, z); }

  makeMoveFlag() {
    const flag=new THREE.Group();flag.visible=false;
    // Face the overview camera so the small destination flag remains readable from above.
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(.065,.065,3.6,6),new THREE.MeshBasicMaterial({color:'#fff0cc',depthTest:false}));
    pole.position.y=1.8;pole.renderOrder=100;flag.add(pole);
    const shape=new THREE.Shape();
    shape.moveTo(0,3.6);shape.lineTo(2,3.6);shape.lineTo(1.55,2.95);shape.lineTo(2,2.3);shape.lineTo(0,2.3);shape.closePath();
    const cloth=new THREE.Mesh(new THREE.ShapeGeometry(shape),new THREE.MeshBasicMaterial({color:'#ef3f3f',side:THREE.DoubleSide,depthTest:false}));
    cloth.renderOrder=101;flag.add(cloth);
    for(const part of flag.children){part.material.depthWrite=false;part.material.toneMapped=false;}
    return flag;
  }
  showMoveFlag(x,y) {
    this.moveFlag.position.set(x,this.ground(x,y)+.12,y);
    this.moveFlagUntil=performance.now()+1000;
    this.moveFlag.visible=true;
  }

  makeTerrain() {
    const rand = W.random(W.seed);
    const geo = new THREE.PlaneGeometry(108, 108, 88, 88);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const river = Math.abs(x - W.riverX(z));
      pos.setY(i, river < 2.6 ? -0.72 : this.ground(x, z));
    }
    const flat = geo.toNonIndexed(); geo.dispose();
    const p = flat.attributes.position; const colors = [];
    for (let i = 0; i < p.count; i += 3) {
      const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
      const z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
      let color = '#8eaa6a';
      if (Math.abs(x - W.riverX(z)) < 4.4) color = '#c0ba8c';
      for (const r of W.regions) if (Math.hypot(x - r.x, z - r.y) < r.radius) {
        color = ['#b1a07a', '#a8a969', '#749365', '#a4a394'][r.type];
      }
      if (Math.abs(x) > 48 || Math.abs(z) > 48) color = '#82916d';
      const c = new THREE.Color(color).multiplyScalar(0.93 + rand() * 0.14);
      for (let j = 0; j < 3; j++) colors.push(c.r, c.g, c.b);
    }
    flat.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); flat.computeVertexNormals();
    const ground = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
    ground.receiveShadow = true; this.scene.add(ground);
    mesh(this.scene, 'box', '#718675', 0, -2.2, 0, 108, 3, 108);
    // A continuous river ribbon follows the banks; it is shallow and traversable.
    const riverVerts = [];
    for (let z = -54; z < 54; z++) {
      const a = W.riverX(z), b = W.riverX(z + 1), w = 2.8;
      riverVerts.push(a-w,-.20,z, a+w,-.20,z, b-w,-.20,z+1, a+w,-.20,z, b+w,-.20,z+1, b-w,-.20,z+1);
    }
    const riverGeo = new THREE.BufferGeometry();
    riverGeo.setAttribute('position', new THREE.Float32BufferAttribute(riverVerts, 3)); riverGeo.computeVertexNormals();
    this.water = new THREE.Mesh(riverGeo, new THREE.MeshStandardMaterial({ color: '#69aeb4', roughness: .36, metalness: .15, side: THREE.DoubleSide }));
    this.scene.add(this.water);
    for (const z of W.bridges) {
      const x = W.riverX(z);
      for (let i = 0; i < 17; i++) mesh(this.scene, 'box', i % 2 ? '#b79a6a' : '#c7aa79', x - 4 + i * .5, .42, z, .47, .3, 4.5);
      for (const side of [-1, 1]) {
        mesh(this.scene, 'box', '#746345', x, 1.15, z + side * 2.1, 9, .18, .16);
        for (let i = -4; i <= 4; i += 2) mesh(this.scene, 'box', '#776243', x + i, .72, z + side * 2.1, .25, 1.6, .25);
      }
      this.path([[-40,z+1],[-25,z-3],[x-5,z]], 1.65);
      this.path([[x+5,z],[23,z+3],[42,z-1]], 1.65);
    }
    this.path([[-34,17],[-29,3],[-26,-22],[-4,-26]], 1.1);
    this.path([[34,-20],[30,-6],[28,22],[8,28]], 1.1);
  }

  path(points, width) {
    const verts = [];
    for (let i = 1; i < points.length; i++) {
      const [x1,z1] = points[i-1], [x2,z2] = points[i];
      const len = Math.hypot(x2-x1,z2-z1), nx = -(z2-z1)/len*width/2, nz = (x2-x1)/len*width/2;
      const segments = Math.ceil(len);
      for(let j=0;j<segments;j++) {
        const a=j/segments,b=(j+1)/segments;
        const ax=x1+(x2-x1)*a,az=z1+(z2-z1)*a,bx=x1+(x2-x1)*b,bz=z1+(z2-z1)*b;
        const v = [[ax+nx,az+nz],[ax-nx,az-nz],[bx+nx,bz+nz],[ax-nx,az-nz],[bx-nx,bz-nz],[bx+nx,bz+nz]];
        for(const [x,z] of v) verts.push(x,this.ground(x,z)+.035,z);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts,3)); g.computeVertexNormals();
    const road = new THREE.Mesh(g, new THREE.MeshStandardMaterial({color:'#c8b88c',roughness:1,side:THREE.DoubleSide})); road.receiveShadow=true;this.scene.add(road);
  }

  makeLandscape() {
    const batches = new Map();
    const add = (shape,color,x,y,z,sx,sy,sz,rotation=0,solid=false) => {
      const key = shape+color+solid;
      if (!batches.has(key)) batches.set(key,{shape,color,solid,items:[]});
      const obj = new THREE.Object3D(); obj.position.set(x,y,z);obj.scale.set(sx,sy,sz);obj.rotation.y=rotation;obj.updateMatrix();
      batches.get(key).items.push(obj.matrix.clone());
    };
    const tree = (x,z,size,c) => {
      const y=this.ground(x,z);
      add('cylinder','#766145',x,y+size*1.1,z,.19*size,2.2*size,.19*size,0,true);
      add('cone',c,x,y+size*2.2,z,1.3*size,2.5*size,1.3*size,0,true);
      add('cone',c,x,y+size*3.3,z,.98*size,2.3*size,.98*size,0,true);
      add('cone',c,x,y+size*4.2,z,.62*size,1.8*size,.62*size,0,true);
    };
    const scenery=W.scenery();
    for(const t of scenery.trees)tree(t.x,t.y,t.size,t.color);
    for(const r of scenery.rocks)add('rock',r.color,r.x,r.height,r.y,r.size,r.sy,r.sz,r.rotation,r.solid);
    for (const [index,r] of W.regions.entries()) {
      const label=document.createElement('div'); label.className='map-label';
      label.append(document.createTextNode(r.name));
      const sub=document.createElement('small');sub.textContent=['GOLD MINE','FARMLAND','WOODLAND','IRON QUARRY'][r.type];label.append(sub);
      document.getElementById('labels').append(label); this.labels.push({el:label,x:r.x,z:r.y+6});
      if(r.type===0 || r.type===3) {
        const group=new THREE.Group();group.position.set(r.x,this.ground(r.x,r.y),r.y-2.2);this.scene.add(group);
        this.movementBlockers.push(group);
        mesh(group,'rock','#8d9487',0,1.3,-1,3.5,2.6,2.5);
        mesh(group,'box','#283c36',0,1,1.1,2,2,0.15);
        mesh(group,'box','#756448',-1.2,1.2,1.35,.3,2.4,.4);
        mesh(group,'box','#756448',1.2,1.2,1.35,.3,2.4,.4);
        mesh(group,'box','#a18a61',0,2.3,1.35,3,.35,.5);
        for(const side of [-1,1]) mesh(group,'box','#626d65',side*.52,.1,3,.1,.1,3.7);
        for(let j=0;j<6;j++) mesh(group,'box','#96805b',0,.06,1.6+j*.55,1.5,.08,.16);
        mesh(group,'box','#766d53',0,.55,3.2,1.1,.8,1.2);
      }
      if(r.type===1) {
        for(let row=0;row<8;row++) for(let col=0;col<17;col++) {
          const x=r.x-6+col*.68,z=r.y-4+row*.9;
          add('box','#8d8053',x,this.ground(x,z)+.04,z,.65,.08,.65);
          add('cone',row%2?'#c3b85e':'#ddcc78',x,this.ground(x,z)+.4,z,.18,.7,.18);
        }
        const mill=new THREE.Group();mill.position.set(r.x+5,this.ground(r.x+5,r.y),r.y-4);this.scene.add(mill);
        this.movementBlockers.push(mill);
        mesh(mill,'cylinder','#e1d8b5',0,1.9,0,.9,3.8,.9);
        mesh(mill,'cone','#9b7652',0,4.1,0,1.35,1.5,1.35);
        const sails=new THREE.Group();sails.position.set(0,3.35,1.1);mill.add(sails);
        for(let j=0;j<4;j++){const arm=new THREE.Group();arm.rotation.z=j*Math.PI/2;mesh(arm,'box','#eee2bd',0,1.05,0,.42,2.5,.09);sails.add(arm);}
        mesh(sails,'sphere','#856e4b',0,0,.1,.24,.24,.24);this.windmills.push(sails);
        for(let i=0;i<5;i++) add('box','#9b885d',r.x-6+i*3,this.ground(r.x-6+i*3,r.y+4)+.5,r.y+4,.15,1,.15,0,true);
        add('box','#b5a178',r.x,.72,r.y+4,12,.12,.12,0,true);
      }
    }
    for(const {shape,color,items,solid} of batches.values()) {
      const m=new THREE.InstancedMesh(geometries[shape],mat(color),items.length);
      items.forEach((matrix,i)=>m.setMatrixAt(i,matrix));m.castShadow=true;m.receiveShadow=true;this.scene.add(m);
      if(solid)this.movementBlockers.push(m);
    }
  }

  makeUnit(u) {
    const root=new THREE.Group(), body=new THREE.Group();root.add(body);
    const color=factionColor(u.faction), dark='#34473d';
    mesh(body,'sphere',color,0,1.83,0,.32,.34,.32);
    mesh(body,'cylinder',dark,0,1.15,0,.12,.8,.12);
    mesh(body,'box',color,0,1.39,0,.5,.35,.29);
    const limbs=[];
    for(const side of [-1,1]) {
      const leg=new THREE.Group();leg.position.set(side*.16,.79,0);mesh(leg,'cylinder',dark,0,-.33,0,.075,.7,.075);body.add(leg);limbs.push(leg);
      const arm=new THREE.Group();arm.position.set(side*.33,1.48,0);arm.rotation.z=side*.22;mesh(arm,'cylinder',dark,0,-.29,0,.065,.62,.065);body.add(arm);limbs.push(arm);
    }
    if(u.type===1){mesh(limbs[3],'box','#d6e4de',0,-.7,0,.11,.8,.07);mesh(limbs[1],'box',color,0,-.25,.12,.4,.5,.1);}
    else if(u.type===0){mesh(limbs[3],'box','#8c6f48',0,-.7,0,.09,.75,.1);mesh(limbs[3],'box','#b0bcb4',0,-1.04,0,.55,.12,.12);}
    let bow=null,string=null,nocked=null;
    if(u.type===2){
      bow=new THREE.Group();bow.position.set(-.35,1.25,.65);body.add(bow);
      const curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(0,-.65,0),new THREE.Vector3(0,0,.45),new THREE.Vector3(0,.65,0));
      const arc=new THREE.Mesh(new THREE.TubeGeometry(curve,16,.045,5,false),mat('#d2b079'));bow.add(arc);
      const stringGeometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,-.65,0),new THREE.Vector3(),new THREE.Vector3(0,.65,0)]);
      string=new THREE.Line(stringGeometry,new THREE.LineBasicMaterial({color:'#eee5bc'}));bow.add(string);
      nocked=mesh(bow,'box','#eee0ac',0,0,.25,.035,.035,1.1);
    }
    const ring=new THREE.Mesh(new THREE.RingGeometry(.55,.67,24),new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide}));
    ring.rotation.x=-Math.PI/2;ring.position.y=.05;root.add(ring);
    const bar=new THREE.Group();bar.position.y=2.5;root.add(bar);
    mesh(bar,'box','#31453d',0,0,0,1.04,.12,.04);
    const health=mesh(bar,'box','#bfe0a0',0,0,.03,1,.075,.03);
    const slash=new THREE.Mesh(new THREE.RingGeometry(.7,1.8,24,1,0,Math.PI),new THREE.MeshBasicMaterial({color:'#fff0ba',side:THREE.DoubleSide,transparent:true,opacity:.7,depthWrite:false}));
    slash.rotation.x=-Math.PI/2;slash.position.y=1;slash.visible=false;body.add(slash);
    root.userData={body,limbs,ring,bar,health,bow,string,nocked,slash,unitId:u.id,faction:u.faction};root.position.set(u.x,this.ground(u.x,u.y),u.y);
    this.scene.add(root);return root;
  }

  makeBase(b,tower=false) {
    const g=new THREE.Group();g.position.set(b.x,this.ground(b.x,b.y),b.y);const c=factionColor(b.faction);
    if(tower){
      for(const x of [-.65,.65])for(const z of [-.65,.65])mesh(g,'box','#887755',x,1.6,z,.24,3.2,.24);
      mesh(g,'box','#bca47b',0,2.9,0,2,.3,2);mesh(g,'cone',c,0,4,0,1.65,1.4,1.65);
    }else{
      mesh(g,'cylinder','#9b9c7a',0,.08,0,4.4,.18,4.4);
      mesh(g,'box','#d9cfaa',0,1.35,0,3.6,2.6,3.4);
      const roof=mesh(g,'cone',c,0,3.3,0,3.1,2,3.1);roof.rotation.y=Math.PI/4;
      mesh(g,'box','#635f49',0,.9,1.72,.8,1.6,.12);
      for(const x of [-1.1,1.1])mesh(g,'box','#6c877b',x,1.7,1.72,.5,.65,.1);
      for(let i=0;i<8;i++){const a=i*Math.PI/4;mesh(g,'box','#9e8c64',Math.cos(a)*4,.5,Math.sin(a)*4,.25,1,.25);}
      mesh(g,'box','#9e875c',2.7,.4,1.9,.85,.8,.8);mesh(g,'box','#ac9669',2.7,.3,2.9,.7,.6,.7);
    }
    mesh(g,'cylinder','#685f48',2,3,0,.06,6,.06);mesh(g,'box',c,2.65,5.4,0,1.3,.7,.05);
    g.userData.faction=b.faction;this.scene.add(g);return g;
  }

  makeNode(n) {
    const g=new THREE.Group();g.position.set(n.x,this.ground(n.x,n.y),n.y);
    if(n.type===2){
      mesh(g,'cylinder','#775b3f',0,.4,0,.55,.8,.55);
      for(let i=0;i<3;i++){const log=mesh(g,'cylinder','#b89b6d',i*.4-.4,.28,0,.22,1.4,.22);log.rotation.x=Math.PI/2;}
    } else if(n.type===1){
      mesh(g,'box','#d8c379',0,.4,0,1.2,.8,.8);mesh(g,'box','#8b7951',0,.42,0,.16,.85,.85);
    } else {
      mesh(g,'rock','#78867f',0,.3,0,1.2,.6,1);
      for(let i=0;i<3;i++){const c=mesh(g,'rock',n.type===0?'#e4c56d':'#9bc1c3',(i-1)*.48,.65+i*.07,0,.35,.65,.35);c.rotation.z=(i-1)*.3;}
    }
    const ring=new THREE.Mesh(new THREE.RingGeometry(.95,1.2,28),new THREE.MeshBasicMaterial({color:'#888888',side:THREE.DoubleSide,transparent:true,opacity:.4,depthWrite:false}));
    ring.rotation.x=-Math.PI/2;ring.position.y=.06;ring.visible=false;g.add(ring);
    g.userData.ring=ring;
    this.scene.add(g);return g;
  }

  groundPoint(x,y){
    this.raycaster.setFromCamera(new THREE.Vector2(x/innerWidth*2-1,1-y/innerHeight*2),this.camera);
    const point=new THREE.Vector3();
    if(!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),point))return null;
    this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-this.ground(point.x,point.z)),point);
    return {x:point.x,y:point.z};
  }
  movementPoint(x,y){
    const point=this.groundPoint(x,y);
    if(!point)return {error:'请选择地图范围内的地面'};
    const error=W.movementError(point.x,point.y,this.state);
    if(error)return {error};
    // Also reject clicking the visible canopy/roof instead of projecting through it onto ground behind.
    const objects=[...this.movementBlockers,...this.bases.values(),...this.towers.values(),...this.sites.values(),...this.nodes.values()];
    const hit=this.raycaster.intersectObjects(objects,true)[0];
    const ground=new THREE.Vector3(point.x,this.ground(point.x,point.y),point.y);
    if(hit&&hit.distance<=this.raycaster.ray.origin.distanceTo(ground)+.2)return {error:'障碍物上不能设置目的地'};
    return point;
  }
  showBuildPreview(x,y,valid,faction){
    this.showBuildRanges(faction);
    if(!this.buildPreview){
      this.buildPreview=this.makeBase({x:0,y:0,faction},true);
      this.buildPreview.traverse(o=>{if(o.isMesh){o.material=o.material.clone();o.material.transparent=true;o.material.opacity=.5;o.material.depthWrite=false;o.castShadow=false;}});
      const footprint=new THREE.Mesh(new THREE.RingGeometry(1.7,1.9,36),new THREE.MeshBasicMaterial({color:'#bddb9d',side:THREE.DoubleSide,transparent:true,opacity:.85}));
      footprint.rotation.x=-Math.PI/2;footprint.position.y=.1;this.buildPreview.add(footprint);
    }
    this.buildPreview.position.set(x,this.ground(x,y),y);
    this.buildPreview.traverse(o=>{if(o.isMesh)o.material.color.set(valid?'#bddd9d':'#ef9276');});
  }
  hideBuildPreview(){
    this.hideBuildRanges();
    if(!this.buildPreview)return;
    this.scene.remove(this.buildPreview);
    this.buildPreview.traverse(o=>{if(o.material)o.material.dispose();if(o.geometry&&!Object.values(geometries).includes(o.geometry))o.geometry.dispose();});
    this.buildPreview=null;
  }
  showBuildRanges(faction){
    const bases=(this.state?.bases||[]).filter(b=>b.faction===faction);
    const key=bases.map(b=>`${b.id}:${b.x}:${b.y}`).join('|');
    if(this.buildRanges&&key===this.buildRangesKey)return;
    this.hideBuildRanges();this.buildRangesKey=key;this.buildRanges=new THREE.Group();
    for(const base of bases){
      const fillGeometry=new THREE.RingGeometry(6,W.buildRadius,96,4);fillGeometry.rotateX(-Math.PI/2);
      const positions=fillGeometry.attributes.position;
      for(let i=0;i<positions.count;i++)positions.setY(i,this.ground(base.x+positions.getX(i),base.y+positions.getZ(i))+.065);
      fillGeometry.computeVertexNormals();
      const fill=new THREE.Mesh(fillGeometry,new THREE.MeshBasicMaterial({color:'#b4d994',transparent:true,opacity:.1,side:THREE.DoubleSide,depthWrite:false}));
      fill.position.set(base.x,0,base.y);this.buildRanges.add(fill);
      for(const radius of [6,W.buildRadius]){
        const points=Array.from({length:96},(_,i)=>{const a=i/96*Math.PI*2,x=base.x+Math.cos(a)*radius,z=base.y+Math.sin(a)*radius;return new THREE.Vector3(x,this.ground(x,z)+.12,z);});
        const line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:radius===6?'#e5b285':'#daebb1',transparent:true,opacity:.85}));this.buildRanges.add(line);
      }
    }
    this.scene.add(this.buildRanges);
  }
  hideBuildRanges(){
    if(!this.buildRanges)return;
    this.scene.remove(this.buildRanges);this.buildRanges.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.buildRanges=null;this.buildRangesKey='';
  }
  showTowerRange(tower){
    if(!tower){this.hideTowerRange();return;}
    const key=`${tower.id}:${tower.range}:${tower.x}:${tower.y}`;
    if(this.towerRange&&key===this.towerRangeKey)return;
    this.hideTowerRange();this.towerRangeKey=key;this.towerRange=new THREE.Group();
    const radius=tower.range;
    const fillGeometry=new THREE.RingGeometry(Math.max(.01,radius-.12),radius,96,4);fillGeometry.rotateX(-Math.PI/2);
    const positions=fillGeometry.attributes.position;
    for(let i=0;i<positions.count;i++)positions.setY(i,this.ground(tower.x+positions.getX(i),tower.y+positions.getZ(i))+.06);
    fillGeometry.computeVertexNormals();
    const fill=new THREE.Mesh(fillGeometry,new THREE.MeshBasicMaterial({color:'#ffd27a',transparent:true,opacity:.12,side:THREE.DoubleSide,depthWrite:false}));
    fill.position.set(tower.x,0,tower.y);this.towerRange.add(fill);
    const points=Array.from({length:96},(_,i)=>{const a=i/96*Math.PI*2,x=tower.x+Math.cos(a)*radius,z=tower.y+Math.sin(a)*radius;return new THREE.Vector3(x,this.ground(x,z)+.12,z);});
    const line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:'#ffd27a',transparent:true,opacity:.9}));
    this.towerRange.add(line);
    this.scene.add(this.towerRange);
  }
  hideTowerRange(){
    if(!this.towerRange)return;
    this.scene.remove(this.towerRange);this.towerRange.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.towerRange=null;this.towerRangeKey='';
  }
  makeSite(site){
    const g=new THREE.Group();g.position.set(site.x,this.ground(site.x,site.y),site.y);
    mesh(g,'box','#ad9d78',0,.1,0,2.8,.2,2.8);
    for(const x of [-1.3,1.3])for(const z of [-1.3,1.3])mesh(g,'box','#bdab7d',x,1.6,z,.12,3.2,.12);
    for(const z of [-1.3,1.3])for(const y of [1,2,3])mesh(g,'box','#bdab7d',0,y,z,2.8,.12,.12);
    const model=this.makeBase({x:0,y:0,faction:site.faction},true);this.scene.remove(model);model.position.set(0,0,0);g.add(model);
    const bar=new THREE.Group();bar.position.y=5.7;
    mesh(bar,'box','#344d3b',0,0,0,2.5,.16,.05);
    const fill=mesh(bar,'box','#e6c27f',0,0,.05,2.4,.11,.05);g.add(bar);
    const label=document.createElement('div');label.className='site-label';document.getElementById('labels').append(label);
    g.userData={faction:site.faction,model,bar,fill,label};this.scene.add(g);return g;
  }

  sync(state) {
    if(this.state && state.time<this.state.time){for(const l of this.damageLabels)l.el.remove();this.damageLabels=[];}
    this.receivedAt=performance.now();
    this.state=state;
    const reconcile=(list,map,create) => {
      const ids=new Set(list.map(x=>x.id));
      for(const [id,obj] of map) if(!ids.has(id)){this.scene.remove(obj);obj.userData.label?.remove();obj.traverse(o=>{if(o.geometry && !Object.values(geometries).includes(o.geometry))o.geometry.dispose();if(o.material && ![...mats.values()].includes(o.material))o.material.dispose();});map.delete(id);}
      for(const data of list) {
        let obj=map.get(data.id);
        if(obj && obj.userData.faction!=null && obj.userData.faction!==data.faction){this.scene.remove(obj);obj.userData.label?.remove();map.delete(data.id);obj=null;}
        if(!obj){obj=create(data);map.set(data.id,obj);}
        const old=obj.userData.target;
        if(old?.hp>data.hp && old.maxHp===data.maxHp){
          const el=document.createElement('span');el.className='damage-number';el.textContent='−'+Number((old.hp-data.hp).toFixed(1));
          document.getElementById('labels').append(el);this.damageLabels.push({el,x:data.x,z:data.y,born:performance.now()});
        }
        obj.userData.target=data;
      }
    };
    reconcile(state.units,this.units,u=>this.makeUnit(u));
    reconcile(state.bases,this.bases,b=>this.makeBase(b));
    reconcile(state.towers,this.towers,t=>this.makeBase(t,true));
    reconcile(state.sites||[],this.sites,s=>this.makeSite(s));
    reconcile(state.nodes,this.nodes,n=>this.makeNode(n));
    reconcile(state.projectiles||[],this.arrows,p=>{
      const g=new THREE.Group();mesh(g,'box','#efe1ae',0,0,0,.045,.045,.9);
      const tip=mesh(g,'cone','#dde8dc',0,0,.55,.11,.25,.11);tip.rotation.x=Math.PI/2;
      g.position.set(p.x,this.ground(p.x,p.y)+1.25,p.y);g.rotation.y=Math.atan2(p.dx,p.dy);this.scene.add(g);return g;
    });
    for(const n of state.nodes){
      const obj=this.nodes.get(n.id);
      obj.scale.setScalar(n.amount>0? .7+.3*n.amount/n.maxAmount : .35);
      if(obj.userData.ring){obj.userData.ring.visible=n.owner>=0;if(n.owner>=0)obj.userData.ring.material.color.set(factionColor(n.owner));}
    }
  }

  pick(x,y,faction) {
    this.raycaster.setFromCamera(new THREE.Vector2(x/innerWidth*2-1,1-y/innerHeight*2),this.camera);
    const objects=[...this.units.values()].filter(o=>o.userData.faction===faction);
    for(const hit of this.raycaster.intersectObjects(objects,true)) {
      let o=hit.object;while(o && o.userData.unitId==null)o=o.parent;
      if(o)return o.userData.unitId;
    }
    // A small screen-space tolerance makes distant stick figures easy to select.
    let best=null,dist=22;
    for(const o of objects){const p=o.position.clone().add(new THREE.Vector3(0,1,0)).project(this.camera);const d=Math.hypot((p.x+1)*innerWidth/2-x,(1-p.y)*innerHeight/2-y);if(p.z<1&&d<dist){dist=d;best=o.userData.unitId;}}
    return best;
  }
  pickTower(x,y,faction){
    this.raycaster.setFromCamera(new THREE.Vector2(x/innerWidth*2-1,1-y/innerHeight*2),this.camera);
    const objects=[...this.towers.values()].filter(o=>o.userData.faction===faction);
    for(const hit of this.raycaster.intersectObjects(objects,true)){
      let o=hit.object;while(o&&!o.userData.target)o=o.parent;
      if(o)return o.userData.target;
    }
    return null;
  }
  pickBase(x,y,faction){
    this.raycaster.setFromCamera(new THREE.Vector2(x/innerWidth*2-1,1-y/innerHeight*2),this.camera);
    const objects=[...this.bases.values()].filter(o=>o.userData.faction===faction);
    for(const hit of this.raycaster.intersectObjects(objects,true)){
      let o=hit.object;while(o&&!o.userData.target)o=o.parent;
      if(o)return o.userData.target;
    }
    return null;
  }
  pickNode(x,y){
    this.raycaster.setFromCamera(new THREE.Vector2(x/innerWidth*2-1,1-y/innerHeight*2),this.camera);
    const objects=[...this.nodes.values()];
    for(const hit of this.raycaster.intersectObjects(objects,true)){
      let o=hit.object;while(o&&!o.userData.target)o=o.parent;
      if(o)return o.userData.target;
    }
    return null;
  }
  unitsInRectangle(x1,y1,x2,y2,faction){
    const left=Math.min(x1,x2),right=Math.max(x1,x2),top=Math.min(y1,y2),bottom=Math.max(y1,y2);
    const ids=[];
    for(const [id,obj] of this.units){
      if(obj.userData.faction!==faction)continue;
      const p=obj.position.clone().add(new THREE.Vector3(0,1,0)).project(this.camera);
      const x=(p.x+1)*innerWidth/2,y=(1-p.y)*innerHeight/2;
      if(p.z>-1&&p.z<1&&x>=left&&x<=right&&y>=top&&y<=bottom)ids.push(id);
    }
    return ids;
  }

  pickEnemy(x,y,faction) {
    this.raycaster.setFromCamera(new THREE.Vector2(x/innerWidth*2-1,1-y/innerHeight*2),this.camera);
    const candidates=[...this.units.values(),...this.bases.values(),...this.towers.values(),...this.sites.values()].filter(o=>o.userData.faction!==faction);
    for(const hit of this.raycaster.intersectObjects(candidates,true)){
      let o=hit.object;while(o&&!o.userData.target)o=o.parent;
      if(o){const kind=this.units.has(o.userData.target.id)?'unit':this.bases.has(o.userData.target.id)?'base':this.sites.has(o.userData.target.id)?'site':'tower';return {kind,...o.userData.target};}
    }
    return null;
  }

  aim(u,screenX=innerWidth/2,screenY=innerHeight/2) {
    const enemy=this.pickEnemy(screenX,screenY,u.faction);
    // Crosshair ray projected onto weapon height; arrows follow this direction, not an auto-selected nearby enemy.
    const point=new THREE.Vector3();
    const plane=new THREE.Plane(new THREE.Vector3(0,1,0),-(this.ground(u.x,u.y)+1.25));
    const intersection=this.raycaster.ray.intersectPlane(plane,point);
    let dx=(enemy?enemy.x:intersection?point.x:u.x+this.raycaster.ray.direction.x*18)-u.x;
    let dy=(enemy?enemy.y:intersection?point.z:u.y+this.raycaster.ray.direction.z*18)-u.y;
    const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;
    return {dx,dy,enemy,inRange:enemy&&Math.hypot(enemy.x-u.x,enemy.y-u.y)<=u.range+(enemy.kind==='base'?1.9:.55)};
  }

  resize(){this.renderer.setSize(innerWidth,innerHeight);this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();}

  render(dt,time) {
    const selected=this.state?.you?.possessedUnitId, possessed=this.units.get(selected);
    const clock=(this.state?.time||0)+Math.min((performance.now()-(this.receivedAt||performance.now()))/1000,.15);
    const order=this.units.get(this.commandId)?.userData.target?.order;
    const orderedTarget=order?(order.kind==='unit'?this.units:order.kind==='base'||order.kind==='home'?this.bases:order.kind==='site'?this.sites:this.towers).get(order.id):null;
    this.orderMarker.visible=!!orderedTarget&&!possessed;
    this.moveFlag.visible=performance.now()<this.moveFlagUntil&&!possessed;
    if(this.moveFlag.visible){
      this.moveFlag.quaternion.copy(this.camera.quaternion);
      this.moveFlag.scale.setScalar(Math.max(.65,this.zoom));
    }
    if(orderedTarget){this.orderMarker.position.copy(orderedTarget.position);this.orderMarker.position.y+=.09;this.orderMarker.scale.setScalar(1+Math.sin(time*4)*.06);}
    const smoothing=1-Math.exp(-dt*12);
    for(const obj of this.units.values()) {
      const u=obj.userData.target;if(!u)continue;
      const dx=u.x-obj.position.x,dz=u.y-obj.position.z,moving=Math.hypot(dx,dz)>.025;
      obj.position.x+=dx*smoothing;obj.position.z+=dz*smoothing;
      obj.position.y=this.ground(obj.position.x,obj.position.z);
      if(W.bridges.some(z=>Math.abs(obj.position.z-z)<2.3)&&Math.abs(obj.position.x-W.riverX(obj.position.z))<4.5)obj.position.y=Math.max(.59,obj.position.y);
      if(moving)obj.userData.body.rotation.y=Math.atan2(dx,dz);
      const age=clock-u.attackStartedAt,attacking=age>=0&&age<(u.type===2?.85:.55);
      if(u.possessed||attacking)obj.userData.body.rotation.y=Math.atan2(u.aimX||0,u.aimY??-1);
      const walk=moving?Math.sin(time*11+u.id)*.55:0;
      obj.userData.limbs.forEach((limb,i)=>limb.rotation.x=walk*(i<2?1:-1));
      const data=obj.userData;
      data.body.position.z=0;data.slash.visible=false;
      data.limbs[1].rotation.z=-.22;data.limbs[3].rotation.z=.22;
      if(u.type===2){
        const draw=attacking?age<.38?age/.38:Math.max(0,1-(age-.38)/.13):0;
        data.limbs[1].rotation.x=-1.4;data.limbs[3].rotation.x=-1.2+draw*.7;
        data.limbs[3].rotation.z=-.5*draw;
        const positions=data.string.geometry.attributes.position;positions.setXYZ(1,0,0,-.55*draw);positions.needsUpdate=true;
        data.nocked.visible=!attacking||age<.38;data.nocked.position.z=.25-.55*draw;
        data.bow.rotation.y=Math.sin(Math.max(0,age-.38)*45)*Math.max(0,.65-age)*.25;
      }else if(attacking){
        const phase=Math.min(1,age/.5),swing=Math.sin(phase*Math.PI);
        data.limbs[3].rotation.x=-2.2+phase*4;data.limbs[3].rotation.z=-swing*.9;
        data.body.position.z=swing*.25;
        data.slash.visible=age>.1&&age<.4;data.slash.material.opacity=Math.max(0,1-(age-.1)/.3)*.65;
        data.slash.rotation.z=-phase*2.4;
      }
      const workSite=this.sites.get(u.buildSiteId)?.userData.target;
      if(workSite?.status==='building'&&!u.possessed){
        data.body.rotation.y=Math.atan2(workSite.x-u.x,workSite.y-u.y);
        data.limbs[3].rotation.x=-1.2+Math.sin(time*8)*.8;
      }
      const highlighted=this.selectedIds.has(u.id)||u.id===this.commandId;
      obj.userData.ring.scale.setScalar(u.id===selected||highlighted?1.45:1);
      obj.userData.ring.material.color.set(highlighted?'#ffe39a':factionColor(u.faction));
      obj.userData.bar.quaternion.copy(this.camera.quaternion);
      obj.userData.health.scale.x=Math.max(.01,u.hp/u.maxHp);
    }
    const goal=new THREE.Vector3(),target=new THREE.Vector3();
    if(possessed){
      target.copy(possessed.position).add(new THREE.Vector3(0,1.35,0));
      goal.copy(target).add(new THREE.Vector3(Math.sin(this.yaw)*this.distance*Math.cos(this.pitch),Math.sin(this.pitch)*this.distance,Math.cos(this.yaw)*this.distance*Math.cos(this.pitch)));
      target.add(new THREE.Vector3(-Math.sin(this.yaw)*7,0,-Math.cos(this.yaw)*7));
    }else{
      target.copy(this.focus);
      const aspectFactor=Math.max(1,1.45/this.camera.aspect);
      goal.copy(target).add(new THREE.Vector3(0,103*this.zoom*aspectFactor,66*this.zoom*aspectFactor));
    }
    this.camera.position.lerp(goal,1-Math.exp(-dt*4.3));this.look.lerp(target,1-Math.exp(-dt*6));this.camera.lookAt(this.look);
    for(const l of this.labels){
      const p=new THREE.Vector3(l.x,this.ground(l.x,l.z)+1,l.z).project(this.camera);
      const visible=p.z>-1&&p.z<1&&(!possessed||Math.hypot(l.x-possessed.position.x,l.z-possessed.position.z)<22);
      l.el.style.display=visible?'':'none';l.el.style.left=(p.x+1)*innerWidth/2+'px';l.el.style.top=(1-p.y)*innerHeight/2+'px';
    }
    this.windmills.forEach(m=>m.rotation.z=time*.38);
    for(const site of this.sites.values()){
      const s=site.userData.target,ratio=s.progress/s.duration;
      site.userData.model.scale.y=.15+ratio*.85;site.userData.fill.scale.x=Math.max(.01,ratio);
      site.userData.bar.quaternion.copy(this.camera.quaternion);
      const p=site.position.clone().add(new THREE.Vector3(0,6.1,0)).project(this.camera);
      const label=site.userData.label;label.textContent=s.status==='building'?`施工 ${Math.floor(ratio*100)}% · ${Math.ceil(s.duration-s.progress)}秒`:s.status==='travel'?'工人赶往工地':'暂停 · 等待工人';
      label.style.left=(p.x+1)*innerWidth/2+'px';label.style.top=(1-p.y)*innerHeight/2+'px';label.style.display=p.z<1?'':'none';
    }
    for(const arrow of this.arrows.values()){
      const p=arrow.userData.target;arrow.position.lerp(new THREE.Vector3(p.x,this.ground(p.x,p.y)+1.25,p.y),smoothing);arrow.rotation.y=Math.atan2(p.dx,p.dy);
    }
    for(const label of this.damageLabels){
      const age=(performance.now()-label.born)/1000;
      if(age>1){label.el.remove();continue;}
      const p=new THREE.Vector3(label.x,this.ground(label.x,label.z)+2.6+age*1.8,label.z).project(this.camera);
      label.el.style.left=(p.x+1)*innerWidth/2+'px';label.el.style.top=(1-p.y)*innerHeight/2+'px';label.el.style.opacity=String(1-age);label.el.style.display=p.z<1?'':'none';
    }
    this.damageLabels=this.damageLabels.filter(l=>performance.now()-l.born<1000);
    this.renderer.render(this.scene,this.camera);
  }
}
