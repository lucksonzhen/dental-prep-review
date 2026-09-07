import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
const $=id=>document.getElementById(id),panels=[],cache=new Map();
window.addEventListener('error',e=>{$('fatal').textContent=e.message});window.addEventListener('unhandledrejection',e=>{$('fatal').textContent=String(e.reason)});
const response=await fetch('./shoulder_manifest.json',{cache:'no-store'});if(!response.ok)throw Error('无法读取纠正结果');const data=await response.json();
const baselineName=data.baseline_name||'上一版 R6';
if(data.baseline_name){$('left-mode').options[0].textContent=baselineName;document.querySelector('h1').textContent='牙面与肩台 · '+baselineName+' 对照';document.querySelector('header p').textContent='左 '+baselineName+'，右 '+(data.after_name||'候选')+' · 同步查看牙体、肩台与剖线';}
if(data.after_name)document.querySelector('#right .label').textContent=data.after_name;
if(data.registration_available===false)$('registration-link').hidden=true;
let current=0,serial=0,sync=false,sectionData=null,boundaryData=null,view='front';const C=()=>data.cases[current];
const dirs={front:[0,-1,.1],back:[0,1,.1],sideA:[1,0,.1],sideB:[-1,0,.1],top:[0,0,1],bottom:[0,0,-1]};
const query=new URLSearchParams(location.search);if(Object.hasOwn(dirs,query.get('view')))view=query.get('view');if(query.get('removed')==='1')$('removed').checked=true;if(['segmented','paired','grey','shoulder'].includes(query.get('mode')))$('display-mode').value=query.get('mode');if(query.has('section'))$('section-angle').value=Math.max(0,Math.min(71,Number(query.get('section'))||0));
function draw(p){p.renderer.render(p.scene,p.camera)}
function panel(id){
 const host=$(id),scene=new THREE.Scene();scene.background=new THREE.Color('#19222d');const camera=new THREE.PerspectiveCamera(36,1,.03,1000);camera.up.set(0,0,1);camera.position.set(0,-35,5);
 const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;host.appendChild(renderer.domElement);
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.minDistance=.1;controls.maxDistance=300;const group=new THREE.Group(),guides=new THREE.Group();scene.add(group,guides,new THREE.AmbientLight(0xffffff,1.5));
 const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(2,2,4);camera.add(light);scene.add(camera);const p={host,scene,camera,renderer,controls,group,guides};panels.push(p);
 new ResizeObserver(()=>{renderer.setSize(host.clientWidth,host.clientHeight,false);camera.aspect=host.clientWidth/host.clientHeight;camera.updateProjectionMatrix();draw(p)}).observe(host);
 controls.addEventListener('change',()=>{draw(p);if(sync)return;sync=true;for(const q of panels){if(q===p)continue;q.camera.position.copy(camera.position);q.camera.quaternion.copy(camera.quaternion);q.camera.up.copy(camera.up);q.controls.target.copy(controls.target);q.controls.update();draw(q)}sync=false});return p;
}
const left=panel('left'),right=panel('right');
const ringOverlay=new THREE.Group();right.scene.add(ringOverlay);
const ringInfo=()=>C().report?.algorithm_report?.shoulder_ring;
const fixedTooth=()=>C().report?.algorithm_report?.geometry_policy==='preserve_all_input_faces';
function ringReady(r){return r&&r.status==='applied'&&r.upper_boundary_display?.length&&r.growth_step?.length===r.upper_boundary_display.length}
function ringPoints(points,color,size){if(!points.length)return;const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(points.flat(),3));const object=new THREE.Points(geometry,new THREE.PointsMaterial({color,size,sizeAttenuation:false,depthTest:true}));object.renderOrder=8;ringOverlay.add(object)}
function showRing(){
 clear(ringOverlay);const r=ringInfo();if(!r){draw(right);return}
 if(!ringReady(r)){$('ring-progress').textContent='未生成闭环：'+(r.reason||r.status||'缺少显示坐标');draw(right);return}
 const last=Math.max(...r.growth_step),step=Number($('ring-step').value),complete=step>last,points=r.upper_boundary_display,visible=r.growth_step.map(k=>complete||k<=step),segments={supported:[],inferred:[]},dots={supported:[],inferred:[]};
 let forward=0,backward=0;for(let i=0;i<points.length;i++){if(!visible[i])continue;const type=r.inferred[i]?'inferred':'supported';dots[type].push(points[i]);if(r.growth_direction[i]>0)forward++;if(r.growth_direction[i]<0)backward++;const j=(i+1)%points.length;if(!visible[j]||(!complete&&Math.max(r.growth_step[i],r.growth_step[j])===last))continue;segments[r.inferred[i]||r.inferred[j]?'inferred':'supported'].push(...points[i],...points[j])}
 $('ring-progress').textContent=(complete?'终态 · 路径已闭合':'生长 '+step+' / '+last)+'；两侧已达 '+forward+' / '+backward+' 段';
 if($('show-ring').checked){for(const [type,color] of [['supported','#54e58b'],['inferred','#ffac46']]){addLines(ringOverlay,segments[type],color,4);ringPoints(dots[type],color,4)}if(visible[r.seed_index])ringPoints([points[r.seed_index]],'#ffe36b',12)}draw(right);
}
function setupRing(){
 const r=ringInfo(),ready=ringReady(r);$('ring-controls').hidden=!r;$('ring-section-evidence').hidden=!r;
 for(const id of ['show-ring','ring-step','ring-start','ring-complete'])$(id).disabled=!ready;
 $('ring-step').max=ready?Math.max(...r.growth_step)+1:1;$('ring-step').value=$('ring-step').max;showRing();
}
function ringSectionEvidence(angle){
 const r=ringInfo(),node=$('ring-section-evidence');node.hidden=!r;if(!r)return;if(!ringReady(r)){node.textContent='几何支持分数，非概率；本例没有可展示的闭环。';return}
 const angles=r.angle_display_deg;if(!angles?.length){node.textContent='几何支持分数，非概率；缺少方向显示变换，无法对应当前剖线。';return}
 const distance=(a,b)=>Math.abs(((a-b+540)%360)-180);
 const describe=(target,name)=>{let k=0;for(let i=1;i<angles.length;i++)if(distance(angles[i],target)<distance(angles[k],target))k=i;const score=Number(r.confidence[k]),width=Number(r.width_mm?.[k]??r.selected_width_mm?.[k]);return name+'最近方向 '+Number(r.angle_deg[k]).toFixed(1)+'°：'+(Number.isFinite(score)?score.toFixed(3):'—')+'，'+(r.inferred[k]?'低分推断':'强证据')+'，最终宽度 '+(Number.isFinite(width)?width.toFixed(2):'—')+' mm'};
 node.textContent='几何支持分数，非概率。'+describe(angle,'剖线正向')+'；'+describe((angle+180)%360,'反向')+'。按方向就近对应，剖线原点可能不同；评分对应离散候选，宽度为最终环带。';
}
async function read(info){
 if(cache.has(info.url))return cache.get(info.url);
 const promise=(async()=>{const res=await fetch(info.url);if(!res.ok)throw Error('无法读取模型 '+info.url);const raw=await res.arrayBuffer(),h=new DataView(raw),nv=h.getUint32(0,true),nf=h.getUint32(4,true);if(raw.byteLength!==8+nv*40+nf*12)throw Error('模型不完整');
 const a=new Float32Array(raw,8,nv*10),f=new Uint32Array(raw,8+nv*40,nf*3),pos=new Float32Array(nv*3),norm=new Float32Array(nv*3),rgb=new Float32Array(nv*3);for(let i=0;i<nv;i++)for(let j=0;j<3;j++){pos[i*3+j]=a[i*10+j];norm[i*3+j]=a[i*10+3+j];rgb[i*3+j]=a[i*10+6+j]}const labels=new Uint16Array(nv);for(let i=0;i<nv;i++)labels[i]=a[i*10+9];return {pos,norm,rgb,f,nv,labels};})();cache.set(info.url,promise);return promise;
}
function clear(group){for(const o of [...group.children]){o.geometry?.dispose();o.material?.dispose();group.remove(o)}}
function add(p,m,tint=null,order=0){
 const g=new THREE.BufferGeometry(),rgb=new Float32Array(m.nv*3),col=new THREE.Color(),mode=$('display-mode').value;
 for(let i=0;i<m.nv;i++){const label=m.labels[i];if(m===p.original)col.setRGB(m.rgb[i*3],m.rgb[i*3+1],m.rgb[i*3+2]).convertSRGBToLinear();
  else if(m===p.removed)col.set('#ffa326');else if(mode==='grey')col.set('#b2becb');else if(mode==='shoulder'&&label<6)col.set('#596b7d');
  else {const sid=mode==='paired'&&label>=7?label-5:label;col.set(data.palette[sid]||'#a1adb9');if(mode==='paired'&&label>=7)col.multiplyScalar(.65)}col.toArray(rgb,i*3)}
 g.setAttribute('position',new THREE.BufferAttribute(m.pos,3));g.setAttribute('normal',new THREE.BufferAttribute(m.norm,3));g.setAttribute('color',new THREE.BufferAttribute(rgb,3));g.setIndex(new THREE.BufferAttribute(m.f,1));
 const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.85,metalness:0,side:THREE.DoubleSide,wireframe:$('wire').checked});
 if($('back-grey').checked&&m!==p.original&&m!==p.removed){material.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = vec3(0.32, 0.38, 0.45);')};material.customProgramCacheKey=()=> 'r9-back-grey'}
 p.group.add(new THREE.Mesh(g,material));
 if($('boundary').checked&&m!==p.original&&m!==p.removed){const edges=new Map(),weld=new Map(),ids=[];for(let i=0;i<m.nv;i++){const k=[m.pos[3*i],m.pos[3*i+1],m.pos[3*i+2]].map(x=>x.toFixed(5)).join(',');if(!weld.has(k))weld.set(k,i);ids.push(weld.get(k))}
 for(let i=0;i<m.f.length;i+=3)for(const [a,b] of [[0,1],[1,2],[2,0]]){let u=ids[m.f[i+a]],v=ids[m.f[i+b]];if(u>v)[u,v]=[v,u];const k=u+','+v;edges.set(k,(edges.get(k)||0)+1)}
 const pts=[];for(const [k,n] of edges)if(n===1)for(const id of k.split(',').map(Number))pts.push(...m.pos.slice(id*3,id*3+3));addLines(p.group,pts,'#ec85db',3)}
 if(p===right&&m!==p.removed&&$('linked').checked&&boundaryData)addLines(p.group,boundaryData.lines.flat(2),'#f5f1d5',4);
 if(p===right&&m!==p.removed&&$('axes').checked&&boundaryData)addLines(p.group,boundaryData.side_lines.flat(2),'#a0dcff',4);
}
function addLines(group,pts,color,order){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));const line=new THREE.LineSegments(g,new THREE.LineBasicMaterial({color,depthTest:order===4,transparent:true,opacity:.88}));line.renderOrder=order;group.add(line)}
function fit(){
 const b=new THREE.Box3(new THREE.Vector3(...C().bounds[0]),new THREE.Vector3(...C().bounds[1])),center=b.getCenter(new THREE.Vector3()),r=b.getSize(new THREE.Vector3()).length()/2,dir=new THREE.Vector3(...dirs[view]).normalize();sync=true;
 for(const p of panels){const vf=THREE.MathUtils.degToRad(p.camera.fov),hf=2*Math.atan(Math.tan(vf/2)*p.camera.aspect);p.controls.target.copy(center);p.camera.position.copy(center).addScaledVector(dir,r/Math.sin(Math.min(vf,hf)/2)*1.08);p.camera.up.set(0,view==='top'||view==='bottom'?1:0,view==='top'||view==='bottom'?0:1);p.camera.lookAt(center);p.controls.update();draw(p)}sync=false;
 for(const b of $('views').querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===view));
}
function section(){
 if(!sectionData)return;const s=sectionData[Number($('section-angle').value)],angle=s.angle_deg*Math.PI/180;$('angle-value').textContent=s.angle_deg+'°';$('section-evidence').textContent=fixedTooth()?'本轮保留全部输入曲面；剖线用于检查肩台分区，输入已有的缺损仍会保留。':s.layers.removed.length?(ringInfo()?'此剖面经过基线已剔除的薄片；本次闭环实验没有新增剔除。':'此剖面经过本轮剔除的薄片，橙色显示移除位置。'):'此剖面未经过剔除薄片。';
 ringSectionEvidence(s.angle_deg);
 for(const [p,key,color] of [[left,$('left-mode').value==='original'?'original':'before','#f3ba65'],[right,'after','#54e0dc']]){clear(p.guides);if($('show-section').checked){const pts=[];for(const line of s.layers3d[key])for(const point of line)pts.push(...point);addLines(p.guides,pts,color,5)}draw(p)}
 const canvas=$('section-chart'),ratio=Math.min(devicePixelRatio,2),w=canvas.clientWidth||700,h=310;canvas.width=w*ratio;canvas.height=h*ratio;const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
 const points=[...s.layers.before.flat(),...s.layers.after.flat()];if(!points.length)return;let xmin=Math.min(...points.map(p=>p[0]))-1.5,xmax=Math.max(...points.map(p=>p[0]))+1.5,ymin=Math.min(...points.map(p=>p[1]))-1,ymax=Math.max(...points.map(p=>p[1]))+.6;
 const scale=Math.min((w-90)/(xmax-xmin),(h-50)/(ymax-ymin)),ox=(w-scale*(xmax-xmin))/2,oy=22;const xy=(p)=>[ox+(p[0]-xmin)*scale,oy+(ymax-p[1])*scale];
 ctx.strokeStyle='#2c4052';ctx.fillStyle='#92a6bb';ctx.font='11px sans-serif';ctx.lineWidth=1;
 for(let x=Math.ceil(xmin);x<=xmax;x++){const a=xy([x,ymin]),b=xy([x,ymax]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.fillText(x+'',a[0]-3,a[1]+16)}
 for(let z=Math.ceil(ymin);z<=ymax;z++){const a=xy([xmin,z]),b=xy([xmax,z]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.fillText(z+'',a[0]-24,a[1]+4)}
 for(const [key,color,width] of [['original','#788697',1.3],['before','#f3ba65',3.8],['after','#54e0dc',1.8],['shoulder','#ff5548',3],['removed','#ffa326',3.4]]){ctx.save();ctx.beginPath();ctx.rect(ox,oy,(xmax-xmin)*scale,(ymax-ymin)*scale);ctx.clip();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();for(const line of s.layers[key]){ctx.moveTo(...xy(line[0]));ctx.lineTo(...xy(line[1]))}ctx.stroke();ctx.restore()}
 ctx.fillStyle='#aebed0';ctx.fillText('mm',w-30,h-10);
}
const jsonCache=new Map();async function jsonFile(url){if(!jsonCache.has(url))jsonCache.set(url,fetch(url).then(r=>{if(!r.ok)throw Error('无法读取 '+url);return r.json()}));return jsonCache.get(url)}
async function render(doFit=false){
 const ticket=++serial,c=C();$('status').textContent='加载模型与剖线…';const keys=['original','before','after'];if(c.models.removed)keys.push('removed');
 const results=await Promise.all([...keys.map(k=>read(c.models[k])),jsonFile(c.sections_url),jsonFile(c.boundaries_url)]);if(ticket!==serial)return;
 const m=Object.fromEntries(keys.map((k,i)=>[k,results[i]]));sectionData=results[keys.length];boundaryData=results[keys.length+1];for(const p of panels){clear(p.group);p.original=m.original;p.removed=m.removed}
 add(left,m[$('left-mode').value]);add(right,m.after);if($('removed').checked&&m.removed)add(right,m.removed);$('left-label').textContent=$('left-mode').value==='original'?'原扫描邻域':baselineName;if(doFit)fit();section();showRing();$('status').textContent='已加载 · 左右视图联动';
}
function metric(label,val){const e=document.createElement('div');e.className='metric';const b=document.createElement('b');b.textContent=val;e.append(document.createTextNode(label),b);$('metrics').append(e)}
function choose(id){
 current=Math.max(0,data.cases.findIndex(c=>c.id===id));const c=C(),r=c.report;$('model-help').textContent='拖动旋转 · 滚轮缩放 · 右键平移；左右视图联动。白线：肩台与牙面的交界；浅蓝线：牙面侧边界；'+(fixedTooth()?'本轮保留全部输入曲面，只重新划分标签。':ringInfo()?'橙色薄片：沿用基线的剔除范围，本轮未新增剔除。':'橙色：本轮剔除的薄片。');$('title').textContent=c.name;$('assessment').textContent=c.assessment;$('registration-link').href='./registration.html?stage=registration#'+c.case_id;$('baseline-link').hidden=!c.baseline_url;if(c.baseline_url)$('baseline-link').href=c.baseline_url;
 $('audit-link').href=c.audit_url;$('tooth-link').hidden=!c.download_url;if(c.download_url)$('tooth-link').href=c.download_url;$('metrics').replaceChildren();metric('处理范围',r.algorithm_report?.processing_scope||r.processing_scope||(ringInfo()?'仅肩台分区':r.preserved?'保留基线':'肩台附近'));metric('肩台连续区',r.shoulder_union.components+' 条');metric(fixedTooth()?'本轮剔除面积':ringInfo()?'沿用基线剔除面积':'局部剔除面积',r.trim.removed_area_mm2.toFixed(2)+' mm²');metric('肩台面积',r.shoulder_area_mm2.toFixed(2)+' mm²');
 $('notes').replaceChildren();for(const note of c.notes){const li=document.createElement('li');li.textContent=note;$('notes').append(li)}
 for(const b of $('cases').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.case===c.id));history.replaceState(null,'','#'+c.id);setupRing();render(true);
}
for(const c of data.cases){const b=document.createElement('button');b.className='case';b.dataset.case=c.id;b.textContent=c.name;b.onclick=()=>choose(c.id);$('cases').append(b)}
for(const [sid,name] of [[1,'切端 / 咬合面'],[2,'唇 / 颊侧'],[3,'舌侧'],[4,'近中'],[5,'远中'],[7,'肩台']]){const item=document.createElement('span');item.textContent='● '+name;item.style.color=data.palette[sid];$('legend').append(item)}

for(const b of $('views').querySelectorAll('[data-view]'))b.onclick=()=>{view=b.dataset.view;fit()};$('fit').onclick=fit;
for(const id of ['left-mode','display-mode','linked','axes','back-grey','boundary','wire','removed'])$(id).onchange=()=>render(false);$('section-angle').oninput=section;$('show-section').onchange=section;
$('show-ring').onchange=showRing;$('ring-step').oninput=showRing;$('ring-start').onclick=()=>{$('ring-step').value=0;showRing()};$('ring-complete').onclick=()=>{$('ring-step').value=$('ring-step').max;showRing()};
new ResizeObserver(section).observe($('section-chart'));window.addEventListener('hashchange',()=>choose(location.hash.slice(1)));choose(location.hash.slice(1)||data.cases[0].id);
