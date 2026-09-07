import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
const $=id=>document.getElementById(id);
window.addEventListener('error',e=>{$('fatal').textContent=e.message});
window.addEventListener('unhandledrejection',e=>{$('fatal').textContent=String(e.reason)});
const response=await fetch('./registration_manifest.json',{cache:'no-store'});
if(!response.ok)throw Error('无法加载逐阶段审阅数据');
const data=await response.json(),cache=new Map(),panels=[];
$('batch-report').href=data.report_url||'../registration_review_r7/report.md';
if(data.legacy_color_available===false){$('color-source').value='post';$('color-source').querySelector('[value="post_legacy"]').hidden=true;}
const params=new URLSearchParams(location.search);
let stage=params.get('stage')||'registration',caseIndex=0,serial=0,syncing=false,currentBounds=null,view=params.get('view')||'front',initialInstance=params.get('instance');
if(!['color','registration','extraction','cervical','segmentation'].includes(stage))stage='registration';
const dirs={front:[0,-1,.12],back:[0,1,.12],sideA:[1,0,.12],sideB:[-1,0,.12],top:[0,0,1],bottom:[0,0,-1]};
if(!dirs[view])view='front';
const names={raw:'配准前',coarse:'粗配准',global:'全局精配准',measurement:'提取实际使用的配准'};
const C=()=>data.cases[caseIndex];
const mm=v=>v===null||v===undefined?'不可用':Number(v).toFixed(3)+' mm';
function draw(p){p.renderer.render(p.scene,p.camera)}
function panel(id){
 const host=$(id),scene=new THREE.Scene();scene.background=new THREE.Color('#19222d');
 const camera=new THREE.PerspectiveCamera(36,1,.03,2000);camera.up.set(0,0,1);camera.position.set(0,-35,5);
 const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.localClippingEnabled=true;host.appendChild(renderer.domElement);
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.minDistance=.1;controls.maxDistance=1000;
 const group=new THREE.Group();scene.add(group);scene.add(new THREE.AmbientLight(0xffffff,1.5));
 const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(2,2,4);camera.add(light);scene.add(camera);
 const p={host,scene,camera,renderer,controls,group};panels.push(p);
 new ResizeObserver(()=>{const w=host.clientWidth,h=host.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();draw(p)}).observe(host);
 controls.addEventListener('change',()=>{draw(p);if(syncing)return;syncing=true;for(const o of panels){if(o===p)continue;o.camera.position.copy(camera.position);o.camera.quaternion.copy(camera.quaternion);o.camera.up.copy(camera.up);o.controls.target.copy(controls.target);o.controls.update();draw(o)}syncing=false});
 return p;
}
const left=panel('left'),right=panel('right');
async function read(info){
 if(cache.has(info.url))return cache.get(info.url);
 const promise=(async()=>{
  const r=await fetch(info.url);if(!r.ok)throw Error('模型无法读取：'+info.url);const raw=await r.arrayBuffer();
  const h=new DataView(raw),nv=h.getUint32(0,true),nf=h.getUint32(4,true);
  if(raw.byteLength!==8+nv*40+nf*12)throw Error('模型文件不完整');
  const a=new Float32Array(raw,8,nv*10),f=new Uint32Array(raw,8+nv*40,nf*3);
  const pos=new Float32Array(nv*3),normal=new Float32Array(nv*3),rgb=new Float32Array(nv*3),labels=new Uint16Array(nv);
  for(let i=0;i<nv;i++){for(let j=0;j<3;j++){pos[i*3+j]=a[i*10+j];normal[i*3+j]=a[i*10+3+j];rgb[i*3+j]=a[i*10+6+j]}labels[i]=a[i*10+9]}
  return {pos,normal,rgb,labels,f,nv};
 })();cache.set(info.url,promise);return promise;
}
function geometry(m,mode,only=null){
 const g=new THREE.BufferGeometry(),rgb=new Float32Array(m.nv*3),c=new THREE.Color();
 for(let i=0;i<m.nv;i++){
  const lab=m.labels[i];
  if(mode==='raw')c.setRGB(m.rgb[i*3],m.rgb[i*3+1],m.rgb[i*3+2]).convertSRGBToLinear();
  else if(mode==='instances'){if(lab===0)c.set('#596573');else c.setHSL((lab*.618)%1,.58,.56)}
  else if(mode==='segmentation')c.set(data.palette[lab]||'#96a3b2');
  else if(mode==='difference')c.set(({0:'#45515d',1:'#ccd4dc',2:'#ff4f6e',3:'#49dce4'})[lab]||'#45515d');
  else c.set(mode);
  c.toArray(rgb,i*3);
 }
 g.setAttribute('position',new THREE.BufferAttribute(m.pos,3));g.setAttribute('normal',new THREE.BufferAttribute(m.normal,3));g.setAttribute('color',new THREE.BufferAttribute(rgb,3));
 if(only===null)g.setIndex(new THREE.BufferAttribute(m.f,1));else{const ids=[];for(let i=0;i<m.f.length;i+=3)if(m.labels[m.f[i]]===only&&m.labels[m.f[i+1]]===only&&m.labels[m.f[i+2]]===only)ids.push(m.f[i],m.f[i+1],m.f[i+2]);g.setIndex(ids)}
 return g;
}
function plane(){
 const b=C().target_bounds,z=b[0][2]+(b[1][2]-b[0][2])*(Number($('clip-height').value)/100),s=$('clip-flip').checked?-1:1;
 return new THREE.Plane(new THREE.Vector3(0,0,s),-s*z);
}
function clear(p){for(const o of [...p.group.children]){o.geometry?.dispose();o.material?.dispose();p.group.remove(o)}}
function addBoundary(p,g,matrix){
 // Weld coincident display vertices for edge counting only; the mesh stays unchanged.
 const a=g.getAttribute('position'),idx=g.index.array,keys=new Map(),map=[],xyz=[];
 for(let i=0;i<a.count;i++){const v=[a.getX(i),a.getY(i),a.getZ(i)],k=v.map(x=>Math.round(x*1e4)).join(',');if(!keys.has(k)){keys.set(k,xyz.length);xyz.push(v)}map[i]=keys.get(k)}
 const edges=new Map();for(let i=0;i<idx.length;i+=3)for(const [u,v] of [[0,1],[1,2],[2,0]]){let x=map[idx[i+u]],y=map[idx[i+v]];if(x>y)[x,y]=[y,x];const key=x+','+y;edges.set(key,(edges.get(key)||0)+1)}
 const pts=[];for(const [key,n] of edges)if(n===1){const [i,j]=key.split(',').map(Number);pts.push(...xyz[i],...xyz[j])}
 const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));
 const lines=new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color:'#ff55c7',depthTest:false,transparent:true,opacity:.85,clippingPlanes:$('clip').checked?[plane()]:[]}));
 if(matrix)lines.applyMatrix4(matrix);lines.renderOrder=10;p.group.add(lines);
}
function add(p,m,mode,{opacity=1,matrix=null,only=null,wire=false,boundary=false,order=0}={}){
 const g=geometry(m,mode,only),material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.85,metalness:0,side:THREE.DoubleSide,transparent:opacity<1,opacity,depthWrite:opacity>=1,wireframe:wire||$('wire').checked,clippingPlanes:$('clip').checked?[plane()]:[]});
 const obj=new THREE.Mesh(g,material);if(matrix)obj.applyMatrix4(matrix);obj.renderOrder=order;p.group.add(obj);
 if(boundary&&$('boundary').checked)addBoundary(p,g,matrix);
}
function matrix(kind){return new THREE.Matrix4().fromArray(C().transforms[kind].matrix)}
function box(bounds){return new THREE.Box3(new THREE.Vector3(...bounds[0]),new THREE.Vector3(...bounds[1]))}
function bounds(){
 const c=C();let b;
 if($('scope').value==='arch'){b=box(c.models.pre.bounds);for(const k of stage==='registration'?[$('left-transform').value,$('right-transform').value]:['measurement'])b.union(box(c.models.post.bounds).applyMatrix4(matrix(k)))}
 else if($('scope').value==='tooth')b=box(stage==='color'?(c.instances.find(i=>i.id===Number($('instance').value))?.bounds||c.target_bounds):c.target_bounds);
 else b=box(c.roi_bounds);
 return b;
}
function fit(){
 const b=bounds(),center=b.getCenter(new THREE.Vector3()),size=b.getSize(new THREE.Vector3()),dir=new THREE.Vector3(...dirs[view]).normalize();currentBounds=b;
 syncing=true;for(const p of panels){const radius=size.length()/2;const vf=THREE.MathUtils.degToRad(p.camera.fov);const hf=2*Math.atan(Math.tan(vf/2)*p.camera.aspect);const distance=radius/Math.sin(Math.min(vf,hf)/2)*1.08;p.controls.target.copy(center);p.camera.position.copy(center).addScaledVector(dir,distance);p.camera.up.set(0,0,1);if(view==='top'||view==='bottom')p.camera.up.set(0,1,0);p.camera.lookAt(center);p.controls.update();draw(p)}syncing=false;
 for(const b of $('views').querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===view));
}
function legend(items){$('legend').replaceChildren();for(const [name,color] of items){const span=document.createElement('span'),s=document.createElement('span');s.className='swatch';s.style.background=color;span.append(s,document.createTextNode(name));$('legend').append(span)}}
function url(){const u=new URL(location.href);u.searchParams.set('stage',stage);u.searchParams.set('view',view);if(stage==='color')u.searchParams.set('instance',$('instance').value);else u.searchParams.delete('instance');u.hash=C().id;history.replaceState(null,'',u)}
async function render(doFit=false){
 const ticket=++serial,c=C();$('status').textContent='正在加载模型…';
 const keys=['pre','post','post_legacy','reference','color_target','extracted','segmented','difference'];
 for(const k of ['extracted_non_source','segmented_non_source','corrected','removed'])if(c.models[k])keys.push(k);
 for(const k of Object.keys(c.models))if(k.startsWith('color_omission_'))keys.push(k);
 const values=await Promise.all(keys.map(k=>read(c.models[k])));if(ticket!==serial)return;const m=Object.fromEntries(keys.map((k,i)=>[k,values[i]]));
 panels.forEach(clear);$('registration-options').hidden=stage!=='registration';$('color-options').hidden=stage!=='color';$('extraction-options').hidden=stage!=='extraction';
 $('cervical-options').hidden=stage!=='cervical';
 for(const b of $('stages').children)b.setAttribute('aria-pressed',String(b.dataset.stage===stage));
 if(stage==='registration'){
  for(const [p,k] of [[left,$('left-transform').value],[right,$('right-transform').value]]){
   if($('pre-show').checked)add(p,m.pre,'#58d5e3',{opacity:Number($('pre-opacity').value)/100,wire:$('pre-wire').checked});
   if($('post-show').checked)add(p,m.post,'#f0b35d',{opacity:Number($('post-opacity').value)/100,matrix:matrix(k),order:1});
  }
  $('left-label').textContent=names[$('left-transform').value];$('right-label').textContent=names[$('right-transform').value];
  $('stage-note').textContent='先看目标两侧的稳定邻牙是否重合。备牙本身形状变化属于预备，不能把这部分前后间隙直接当作配准误差。可切换全局与局部配准；单牙提取使用右侧“实际使用的配准”所对应的矩阵。';
  legend([['备牙前','#58d5e3'],['备牙后','#f0b35d']]);
 }else if(stage==='color'){
  const source=m[$('color-source').value];add(left,m.post,$('raw-grey').checked?'#b9c4ce':'raw',{boundary:true});
  add(right,source,'instances',{only:$('isolate').checked?Number($('instance').value):null,boundary:true});
  $('left-label').textContent='完整原扫描 · '+($('raw-grey').checked?'纯灰几何':'原色');$('right-label').textContent=$('isolate').checked?'颜色掩码提取的单牙':'完整几何上的颜色实例标签';
  $('stage-note').textContent='这一页的标签在配准前就已生成。选中邻牙可检查下缘；左侧原扫描若仍有表面，右侧却灰色或单牙中缺失，说明颜色掩码漏标。开启“纯灰”可区分真实几何孔洞与标签空白。两边统一旋转到配准后的坐标，仅用于同角度对照，没有用配准修补标签。';
  const evidence=c.color_evidence?.[$('instance').value];if(evidence){$('stage-note').textContent+=' '+evidence.conclusion;if($('color-evidence').checked)add(right,m['color_omission_'+$('instance').value],'#ff8a28',{order:3})}
  legend([['原扫描未分到牙齿的区域','#596573'],['玫红线：网格开放边界','#ff55c7']]);
 }else if(stage==='extraction'){
  const kind=$('extraction-left').value;
  const missing=!c.color_target_recognized&&c.color_target_fallback==='raw_scan';
  add(left,kind==='color'&&!missing?m.color_target:kind==='difference'?m.difference:m.post,kind==='difference'?'difference':'raw',{boundary:kind==='color'&&!missing});
  if($('context').checked)add(right,m.post,'#556371',{opacity:.22});
  add(right,m.extracted,'#c0c8d1',{boundary:true,order:1});
  if($('reference').checked)for(const p of panels)add(p,m.reference,'#58d5e3',{wire:true,opacity:.5,order:2});
  $('left-label').textContent={color:c.color_target_recognized?'配准前颜色掩码所得单牙 · 已对齐显示':'颜色未识别目标 · 此前恢复的候选单牙',raw:'完整原扫描 · 已对齐显示',difference:c.color_target_recognized?'颜色目标与提取结果 · 原扫描上的差异':'恢复候选与提取结果 · 原扫描上的差异'}[kind];$('right-label').textContent='真实 Step4 输出 · 配准后提取的单牙';
  $('stage-note').textContent='右侧是流水线实际提取的网格，未经本页修补。切换左侧“差异”，查看颜色分牙中有、提取后丢失的部分，以及提取额外纳入的部分；额外纳入的部分可能是漏标牙体，也可能是牙龈，需要对照原扫描。';
  if(missing){$('left-label').textContent=kind==='difference'?'原扫描上的实际提取范围 · 颜色目标未识别':'完整原扫描 · 颜色目标未识别';$('stage-note').textContent='颜色分牙没有识别出参考对应的目标牙。左侧显示原扫描，右侧显示按标准单牙参考提取的真实网格；未用邻牙替代，也没有把提取结果冒充颜色候选。';}
  legend(kind==='difference'?[['两阶段均保留','#ccd4dc'],[c.color_target_recognized?'颜色目标有、提取未保留':'恢复候选有、提取未保留','#ff4f6e'],[c.color_target_recognized?'提取有、颜色目标外':'提取有、恢复候选外','#49dce4']]:[['提取单牙','#c0c8d1'],['非原扫描面（若存在）','#ff8a28']]);
  if(missing&&kind==='difference')legend([['已提取区域','#49dce4'],['其余原扫描','#45515d']]);
 }else if(stage==='cervical'){
  add(left,m.extracted,'#c0c8d1',{boundary:true});add(right,m.corrected,'#c0c8d1',{boundary:true});
  if($('removed-tissue').checked&&m.removed)add(right,m.removed,'#ff9c32',{order:2});
  $('left-label').textContent='单牙提取结果';$('right-label').textContent='分区前的灰色单牙';
  $('stage-note').textContent='这一阶段单独查看颈缘与外伸部分的修正。橙色可显示实际剔除的扫描面；保留部分及新增边界均位于原扫描面上。这里没有通过移动顶点或封洞生成牙体。';
  if(c.qa?.cervical_sections?.molar_mode)$('stage-note').textContent='本例磨牙在分区阶段保持提取网格不变，左右应一致。颜色漏标原面的恢复发生在前一步单牙提取，可切换“单牙目标与提取”查看差异。';
  legend([['保留单牙','#c0c8d1'],['剔除部分','#ff9c32']]);
 }else{
  add(left,m.corrected||m.extracted,'#c0c8d1',{boundary:true});add(right,m.segmented,'segmentation',{boundary:true});
  $('left-label').textContent=m.corrected?'分区前的灰色网格':'Step4 · 提取后的灰色网格';$('right-label').textContent='Step5 · 实际牙面与肩台分区';
  $('stage-note').textContent=m.corrected?'左右具有相同的扫描表面积：左侧看真实牙体形状，右侧看五个牙面及肩台归属。颈缘裁掉哪些部分，请切换“颈缘修正前后”。':'左右直接比较提取与后续分区：如果左侧完整、右侧缺失，排查去龈和分区裁剪；如果两边均缺失，向前检查提取或输入。区域颜色零碎、互相侵入而几何仍完整，则是标签问题。';
  const ring=c.qa?.cervical_sections?.shoulder_ring;
  if(ring)$('stage-note').textContent+=ring.status==='applied'?' 肩台使用连续条带环先验，低支持段可能是推断，闭环不等于整圈都有真实肩台。':' 本例未形成合法闭环；没有肩台输出不代表原牙没有肩台。';
  legend([['切端 / 咬合面','#f3bd45'],['四个轴面','#63b4fa'],['肩台','#ee483c'],['非原扫描面','#ff8a28']]);
 }
 if($('non-source').checked){if(stage==='extraction'&&m.extracted_non_source)add(right,m.extracted_non_source,'#ff8a28',{order:3});if(stage==='segmentation'){if(m.extracted_non_source)add(left,m.extracted_non_source,'#ff8a28',{order:3});if(m.segmented_non_source)add(right,m.segmented_non_source,'#ff8a28',{order:3})}}
 if(doFit)fit();else panels.forEach(draw);$('status').textContent='已加载 · 原始网格分辨率';url();
}
function metric(label,value){const e=document.createElement('div');e.className='metric';const b=document.createElement('b');b.textContent=value;e.append(document.createTextNode(label),b);$('metrics').append(e)}
function choose(id){
 caseIndex=Math.max(0,data.cases.findIndex(c=>c.id===id));const c=C();
 $('title').textContent=c.name;$('old-view').href=(data.comparison_url||'./?v=segmentation-r6-correct-target')+'#'+c.id;
 if(data.comparison_url)$('old-view').textContent=data.comparison_name||'肩台候选对照';
 for(const button of $('stages').children)if(button.dataset.stage==='cervical')button.hidden=!c.models.corrected;
 if(stage==='cervical'&&!c.models.corrected)stage='extraction';
 $('selection').textContent=(c.color_target_recognized?'目标实例 '+c.post_instance:'颜色分牙未识别目标')+' · '+(c.selection_description||(c.selection_user_confirmed?'已按用户截图纠正':'沿用当前审阅目标，仍可核对'));
 $('instance').replaceChildren();for(const item of c.instances){const o=document.createElement('option');o.value=item.id;o.textContent=item.id===0?'未识别区域（标签 0）':'实例 '+item.id+(item.id===c.post_instance?'（当前目标）':'');$('instance').append(o)}$('instance').value=c.post_instance;
 if(initialInstance!==null&&c.instances.some(i=>i.id===Number(initialInstance))){$('instance').value=initialInstance;$('scope').value='tooth';initialInstance=null}
 for(const b of $('cases').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.case===c.id));
 $('metrics').replaceChildren();metric('局部配准状态',c.gate['状态']||c.gate.status);metric('稳定锚点留出 P95',mm(c.gate['留出锚点P95_mm']));metric('候选配准在目标区的分歧',mm(c.gate['备牙ROI候选分歧P95_mm']));metric(c.color_target_recognized?'颜色目标未进入提取':'恢复候选未进入提取',c.qa.color_vertices_lost_in_extraction+' 顶点');
 if(!c.color_target_recognized&&c.color_target_fallback==='raw_scan'){$('metrics').lastElementChild.remove();metric('颜色目标与提取对照','未识别，无法统计');}
 $('notes').replaceChildren();for(const note of c.notes){const li=document.createElement('li');li.textContent=note;$('notes').append(li)}
 $('provenance').textContent='PRE 内部目标标签 '+c.pre_label+'；邻牙标签 '+c.neighbor_labels.join('、')+'。实际读取变换：'+c.measurement_transform+'。'+(c.diagnostic_fallback||'使用备牙前独立单牙范围提取。')+' 单牙颜色与提取差异不等同于分割准确率。';$('audit').href=c.audit_url;
 render(true);
}
for(const c of data.cases){
 const b=document.createElement('button');b.className='case';b.dataset.case=c.id;b.append(document.createTextNode(c.name));const tag=document.createElement('small');tag.textContent=c.gate['状态']||c.gate.status;if(c.gate.status==='FAIL')tag.className='fail';b.append(tag);b.onclick=()=>choose(c.id);$('cases').append(b);
 const tr=document.createElement('tr'),link=document.createElement('a');link.href='#'+c.id;link.textContent=c.name;link.onclick=e=>{e.preventDefault();choose(c.id)};const td=document.createElement('td');td.append(link);tr.append(td);
 for(const val of [c.gate['状态'],mm(c.gate['留出锚点P95_mm']),c.qa.color_vertices_lost_in_extraction??'—',c.qa.extraction_vertices_outside_color??'—',['color','extraction','segmentation'].map(k=>c.qa.topology[k].boundary_components??'—').join(' / ')]){const td=document.createElement('td');td.textContent=val;tr.append(td)}$('summary').append(tr);
}
for(const b of $('stages').children)b.onclick=()=>{stage=b.dataset.stage;if(stage==='registration')$('scope').value='neighbors';else $('scope').value=stage==='color'?'neighbors':'tooth';render(true)};
for(const b of $('views').querySelectorAll('[data-view]'))b.onclick=()=>{view=b.dataset.view;fit();url()};$('fit').onclick=fit;
for(const id of ['left-transform','right-transform','pre-show','post-show','pre-wire','color-source','color-evidence','isolate','raw-grey','extraction-left','context','reference','wire','boundary','non-source','clip','clip-flip','removed-tissue'])$(id).onchange=()=>render(false);
for(const id of ['pre-opacity','post-opacity','clip-height'])$(id).oninput=()=>render(false);
 $('scope').onchange=fit;$('instance').onchange=()=>{$('scope').value='tooth';render(true)};
window.addEventListener('hashchange',()=>choose(location.hash.slice(1)));
if(stage==='extraction'||stage==='cervical'||stage==='segmentation')$('scope').value='tooth';
choose(location.hash.slice(1)||data.cases[0].id);
