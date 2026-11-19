// The map is shared by rendering and the authoritative server (CommonJS / browser).
(function (root) {
  const World = {
    half: 48,
    seed: 173,
    regions: [
      { name: '西境松林', type: 2, x: -26, y: -22, radius: 12 },
      { name: '翡翠林地', type: 2, x: 28, y: 22, radius: 11 },
      { name: '北岭铁矿', type: 3, x: 20, y: -28, radius: 10 },
      { name: '灰岩采石场', type: 3, x: -22, y: 29, radius: 9 },
      { name: '金砂矿场', type: 0, x: -4, y: -26, radius: 8 },
      { name: '落日金矿', type: 0, x: 8, y: 28, radius: 8 },
      { name: '风车麦田', type: 1, x: -29, y: 3, radius: 8 },
      { name: '东岸农庄', type: 1, x: 30, y: -6, radius: 8 },
    ],
    spawns: [ [-34, 17], [34, -20], [-34, -36], [35, 36], [0, -39], [0, 40], [-40, -8], [40, 9], [-17, 12], [17, -12] ],
    // Low rolling ground; the map center and the river banks stay navigable.
    height(x, z) { return 0.22 * Math.sin(x * 0.15) * Math.cos(z * 0.12) + 0.13 * Math.sin(z * 0.27 + x * 0.08); },
    riverX(z) { return Math.sin(z * 0.075) * 4; },
    bridges: [-15, 15],
    buildRadius: 18,
    scenery() {
      if(this._scenery)return this._scenery;
      const rand=this.random(this.seed),trees=[],rocks=[],obstacles=[];
      const tree=(x,y,size)=>{
        const color=['#456d4b','#547e50','#608856','#38644b'][Math.floor(rand()*4)];
        trees.push({x,y,size,color});obstacles.push({x,y,radius:1.3*size});
      };
      const rock=(x,y,size,color,height,sy,sz,rotation,solid=true)=>{
        rocks.push({x,y,size,color,height,sy,sz,rotation,solid});
        if(solid)obstacles.push({x,y,radius:size});
      };
      for(const r of this.regions){
        if(r.type===2)for(let i=0;i<43;i++){
          const a=rand()*Math.PI*2,d=4+rand()*(r.radius-4);
          tree(r.x+Math.cos(a)*d,r.y+Math.sin(a)*d,.65+rand()*.5);
        }
        if(r.type===0||r.type===3){
          for(let i=0;i<19;i++){
            const a=rand()*Math.PI*2,d=5+rand()*(r.radius-4),x=r.x+Math.cos(a)*d,y=r.y+Math.sin(a)*d,s=.7+rand()*1.9;
            rock(x,y,s,r.type===0?'#9c957d':'#7d8c87',this.height(x,y)+s*.5,s*.85,s*.8,rand()*6);
          }
          obstacles.push({x:r.x,y:r.y-3.2,rx:3.5,ry:2.5},{x:r.x,y:r.y+1,rx:.8,ry:1});
        }
        if(r.type===1)obstacles.push({x:r.x+5,y:r.y-4,radius:1.35},{x:r.x,y:r.y+4,rx:6,ry:.15});
      }
      for(let i=0;i<110;i++){
        const x=(rand()-.5)*102,y=(rand()-.5)*102;
        if(Math.abs(x)>44||Math.abs(y)>44)tree(x,y,.7+rand()*.8);
      }
      for(let i=0;i<26;i++){
        const side=i%4,t=(rand()-.5)*112,edge=56+rand()*5;
        const x=side<2?t:(side===2?-edge:edge),y=side<2?(side===0?-edge:edge):t,size=5+rand()*7;
        rock(x,y,size,i%2?'#81958b':'#94a297',size*.25-1,size*.8,size,rand()*6);
      }
      for(let i=0;i<140;i++){
        const x=(rand()-.5)*93,y=(rand()-.5)*93;
        if(Math.abs(x-this.riverX(y))<5)continue;
        rock(x,y,.16+rand()*.32,'#a7ae87',this.height(x,y)+.12,.2,.25,rand()*6,false);
      }
      return this._scenery={trees,rocks,obstacles};
    },
    // The 3 gather spots of every resource region; the server spawns nodes here and the navigation grid keeps them reachable.
    nodeSpots() {
      const out=[];
      for(const r of this.regions)for(let i=0;i<3;i++){
        const a=i*Math.PI*2/3;
        out.push({type:r.type,x:r.x+Math.cos(a)*3,y:r.y+Math.sin(a)*3});
      }
      return out;
    },
    movementError(x,y,state={}) {
      if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>this.half||Math.abs(y)>this.half)return '目的地超出地图范围';
      const inside=o=>o.radius!=null?Math.hypot(x-o.x,y-o.y)<o.radius+.3:Math.abs(x-o.x)<o.rx+.3&&Math.abs(y-o.y)<o.ry+.3;
      if(this.scenery().obstacles.some(inside))return '障碍物上不能设置目的地';
      if((state.bases||[]).some(b=>inside({...b,rx:2,ry:2}))||
        [...(state.towers||[]),...(state.sites||[])].some(b=>inside({...b,rx:1.5,ry:1.5}))||
        (state.nodes||[]).some(n=>inside({...n,radius:1})))return '建筑或资源点上不能设置目的地';
      return '';
    },
    placementError(x, y, state = {}, faction = state.you?.faction) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return '请选择地图上的有效位置';
      if (Math.abs(x) > this.half - 2 || Math.abs(y) > this.half - 2) return '位置超出可建造边界';
      const ownBases=(state.bases||[]).filter(b=>b.faction===faction);
      if(!ownBases.length)return '需要拥有己方基地才能建造';
      if(!ownBases.some(b=>Math.hypot(x-b.x,y-b.y)<=this.buildRadius))return `只能在己方基地周围 ${this.buildRadius} 格内建造`;
      if (Math.abs(x - this.riverX(y)) < 4.5) return '河道与桥梁上不能建造';
      // Units path around static scenery, so a site buried in a tree or rock could never be reached by its builder.
      if (this.scenery().obstacles.some(o => o.radius != null ? Math.hypot(x-o.x,y-o.y) < o.radius+1 : Math.abs(x-o.x) < o.rx+1 && Math.abs(y-o.y) < o.ry+1)) return '障碍物上不能建造';
      if (this.regions.some(r => Math.hypot(x-r.x,y-r.y)<r.radius+1)) return '请避开森林、矿场和农田';
      if ((state.bases||[]).some(b=>Math.hypot(x-b.x,y-b.y)<6)) return '距离基地太近';
      if ([...(state.towers||[]),...(state.sites||[])].some(b=>Math.hypot(x-b.x,y-b.y)<4)) return '与箭塔或施工地点重叠';
      if ((state.nodes||[]).some(n=>Math.hypot(x-n.x,y-n.y)<3)) return '不能占用资源采集点';
      return '';
    },
    random(seed) {
      return function () { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = World;
  else root.World = World;
})(globalThis);
