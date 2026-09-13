import * as THREE from 'three';
import {PanelRenderer, ModelCache} from './render_runtime.js';
import {OrbitControls} from './vendor/OrbitControls.js';
import {DISPLAY_PALETTE, SHOULDER_IDS, SHOULDER_NAMES} from './anatomical_palette.js';

// 独立颈缘查看器：最终结果、同次颈缘原色和真实候选各自使用对应产物。
const $ = id => document.getElementById(id);
const header = document.querySelector('header');
new ResizeObserver(() => document.documentElement.style.setProperty('--review-header-height',`${Math.ceil(header.getBoundingClientRect().height)}px`)).observe(header);
const cache = new ModelCache(8), panels = [];
const directions = {front:[0,-1,.12],back:[0,1,.12],sideA:[1,0,.12],sideB:[-1,0,.12],top:[0,0,1],bottom:[0,0,-1]};
const modeNames = {segmentation:'最终牙面与肩台',grey:'最终灰色牙体',shoulder:'最终肩台高亮',color:'颈缘阶段原色',candidate:'颈缘试验候选',repair:'孔洞诊断与修补预览'};
const query = new URLSearchParams(location.search);
let data, current, holeSession, reconstructionSession, serial = 0, syncing = false, filter = ['11','46'].includes(query.get('fdi')) ? query.get('fdi') : 'all';
let view = Object.hasOwn(directions,query.get('view')) ? query.get('view') : 'front';
if (Object.hasOwn(modeNames,query.get('mode'))) $('display-mode').value = query.get('mode');
$('removed').checked = query.get('removed') === '1';

function showError(error) {
  $('fatal').hidden = false;
  $('fatal').textContent = String(error?.message || error);
}
window.addEventListener('error',event => showError(event.error || event.message));
window.addEventListener('unhandledrejection',event => showError(event.reason));
function draw(panel) { panel.renderer.render(panel.scene,panel.camera); }
function makePanel(id) {
  const host = $(id), scene = new THREE.Scene();
  scene.background = new THREE.Color('#19222d');
  const camera = new THREE.PerspectiveCamera(36,1,.03,2000);
  camera.up.set(0,0,1); camera.position.set(0,-35,5);
  const renderer = new PanelRenderer();
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.hidden = true;
  renderer.domElement.setAttribute('aria-label',id === 'left' ? '左侧三维模型' : '右侧三维模型');
  host.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera,renderer.domElement);
  controls.enableDamping = false; controls.minDistance = .1; controls.maxDistance = 1000;
  const group = new THREE.Group();
  scene.add(group,new THREE.AmbientLight(0xffffff,1.5));
  const light = new THREE.DirectionalLight(0xffffff,2);
  light.position.set(2,2,4); camera.add(light); scene.add(camera);
  const panel = {id,host,scene,camera,renderer,controls,group};
  panels.push(panel);
  const resize = () => {
    const width = host.clientWidth, height = host.clientHeight;
    renderer.setSize(width,height,false);
    camera.aspect = width / Math.max(1,height); camera.updateProjectionMatrix(); draw(panel);
  };
  new ResizeObserver(resize).observe(host); resize();
  controls.addEventListener('change',() => {
    draw(panel);
    if (syncing) return;
    syncing = true;
    for (const other of panels) {
      if (other === panel) continue;
      other.camera.position.copy(camera.position); other.camera.quaternion.copy(camera.quaternion);
      other.camera.up.copy(camera.up); other.camera.zoom = camera.zoom;
      other.camera.updateProjectionMatrix(); other.controls.target.copy(controls.target);
      other.controls.update(); draw(other);
    }
    syncing = false;
  });
  return panel;
}
const left = makePanel('left'), right = makePanel('right');

function clear(panel,message = '') {
  for (const object of [...panel.group.children]) {
    object.geometry?.dispose(); object.material?.dispose(); panel.group.remove(object);
  }
  panel.renderer.domElement.hidden = true;
  panel.renderer.domElement.dataset.modelKey = '';
  panel.host.dataset.modelKey = '';
  panel.host.dataset.holeIds = '';
  panel.host.dataset.holeFaceCount = '0';
  panel.host.dataset.holeBoundaryIds = '';
  panel.host.dataset.holeBoundaryVertexCount = '0';
  $(`${panel.id}-empty`).textContent = message;
  $(`${panel.id}-empty`).hidden = !message;
  $(`${panel.id}-detail`).textContent = '';
  draw(panel);
}
function available(descriptor) { return !!descriptor && typeof descriptor.url === 'string' && !!descriptor.url; }
function autoHoleReview(item = current) { return item?.auto_hole_models?.schema === 'automatic-hole-models-v1' ? item.auto_hole_models : null; }
function autoHoleBoundaryLabels(item = current) {
  const bundle = autoHoleReview(item);
  if (!bundle || !bundle.result_contract_schema || bundle.result_contract_schema === 'automatic-hole-repair-result-v1') return false;
  if (bundle.result_contract_schema !== 'automatic-hole-repair-result-v2' || bundle.labels_policy !== 'retained_exact_boundary_propagated' || bundle.label_assignment_method !== 'fixed_boundary_harmonic') throw Error('自动补面标签契约不受支持');
  return true;
}
function autoHoleLabelNote() {
  return autoHoleBoundaryLabels()
    ? '补面沿相接的已分割牙面边界确定分类，默认显示所属牙面或肩台颜色；缺少有效分区边界时才显示未知标签 0。'
    : '此旧版补面使用未知标签 0，分割模式显示为中性灰。';
}
function autoHoleRanges(item = current) {
  const bundle = autoHoleReview(item);
  if (!bundle) return [];
  const ranges = bundle.estimated_face_ranges, info = item.models?.after;
  if (!Array.isArray(ranges) || !Number.isInteger(info?.faces) || !/^[a-f0-9]{64}$/.test(info.sha256 || '') || !/^[a-f0-9]{64}$/.test(item.models?.before?.sha256 || '') || bundle.complete?.sha256 !== info.sha256 || bundle.original?.sha256 !== item.models?.before?.sha256) throw Error('自动补面模型身份或估计面范围缺失');
  let end = 0;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger) || range[0] < end || range[1] <= range[0] || range[1] > info.faces) throw Error('自动补面估计面范围无效');
    end = range[1];
  }
  return ranges;
}
function versionName(key) {
  const value = data?.[key === 'before' ? 'baseline_name' : 'candidate_name'];
  return typeof value === 'string' && value.trim() ? value.trim() : key === 'before' ? '基线' : '本轮';
}
function modelName(key) {
  if (key === 'candidate') return '颈缘试验候选';
  if (key === 'input') return '本轮颈缘输入原色';
  if (key === 'refined') return '本轮颈缘输出原色';
  return `${versionName(key)} 最终分割`;
}
function removedKey() { return ['candidate','repair'].includes($('display-mode').value) ? null : 'removed'; }
function removedName() { return '颈缘实际删除片'; }
function updateRemovedControl() {
  const diagnostic = $('display-mode').value === 'repair', trial = $('display-mode').value === 'candidate', present = available(current.models?.removed);
  $('removed').disabled = trial || diagnostic || !present;
  if ($('removed').disabled) $('removed').checked = false;
  $('removed-label').textContent = diagnostic ? '孔洞诊断不叠加颈缘删除片' : trial ? '试验模式不叠加正式删除片' : '叠加颈缘实际删除片';
  $('removed-note').textContent = diagnostic ? '孔洞诊断使用正式牙体及独立孔洞预览，不混入颈缘删除片。' : trial ? '试验模式只显示真实候选，正式处理的删除片不叠加到候选上。' : present ? '橙色叠加来自本轮颈缘阶段实际删除片，只显示在右侧，不属于保留牙体。' : '本例未提供实际删除片网格，无法叠加；这不等同于已知删除面积为零。';
}
function modelUrl(url) {
  const resolved = new URL(url,location.href);
  if (!['http:','https:'].includes(resolved.protocol)) throw Error('模型地址不是可读取的网页资源');
  return resolved.href;
}
async function readModel(info) {
  const url = modelUrl(info.url);
  if (cache.has(url)) return cache.get(url);
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw Error(`模型读取失败（HTTP ${response.status}）：${info.url}`);
    const buffer = await response.arrayBuffer();
    if (info.sha256) {
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),byte => byte.toString(16).padStart(2,'0')).join('');
      if (actual !== info.sha256 || (info.bytes != null && buffer.byteLength !== info.bytes)) throw Error(`模型与来源校验不一致：${info.url}`);
    }
    if (buffer.byteLength < 8) throw Error(`模型头不完整：${info.url}`);
    const header = new DataView(buffer), nv = header.getUint32(0,true), nf = header.getUint32(4,true);
    if (!nv || !nf || buffer.byteLength !== 8 + nv * 40 + nf * 12) throw Error(`模型长度或面数无效：${info.url}`);
    if ((info.vertices != null && Number(info.vertices) !== nv) || (info.faces != null && Number(info.faces) !== nf)) throw Error(`模型计数与清单不一致：${info.url}`);
    const packed = new Float32Array(buffer,8,nv * 10), faces = new Uint32Array(buffer,8 + nv * 40,nf * 3);
    const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), rgb = new Float32Array(nv * 3), labels = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const p = packed[i * 10 + axis], n = packed[i * 10 + 3 + axis], color = packed[i * 10 + 6 + axis];
        if (![p,n,color].every(Number.isFinite)) throw Error(`模型存在非有限数值：${info.url}`);
        positions[i * 3 + axis] = p; normals[i * 3 + axis] = n; rgb[i * 3 + axis] = color;
      }
      labels[i] = packed[i * 10 + 9];
    }
    for (const index of faces) if (index >= nv) throw Error(`模型三角面索引越界：${info.url}`);
    return {positions,normals,rgb,labels,faces,nv,nf};
  })();
  cache.set(url,pending);
  return pending;
}
function paletteColor(label) {
  const color = DISPLAY_PALETTE[label] ?? data.palette?.[label] ?? DISPLAY_PALETTE[0];
  return typeof color === 'object' && color !== null && !Array.isArray(color) ? color.color || DISPLAY_PALETTE[0] : color;
}
function setColor(color,value) {
  if (Array.isArray(value)) {
    const divisor = value.some(component => component > 1) ? 255 : 1;
    color.setRGB(value[0] / divisor,value[1] / divisor,value[2] / divisor).convertSRGBToLinear();
  } else color.set(value);
}
function addModel(panel,model,key,mode,removed = false) {
  const auto = autoHoleReview(), ranges = auto && key === 'after' && !removed ? autoHoleRanges() : [];
  if (auto && !removed) {
    if (model.nv !== model.nf * 3 || model.faces.some((value,index) => value !== index)) throw Error('自动补面显示必须使用真实逐面标签');
    if (!autoHoleBoundaryLabels()) for (const [start,end] of ranges) for (let index = start * 3; index < end * 3; index++) if (model.labels[index] !== 0) throw Error('旧版自动补面未知标签应为 0');
  }
  if (!removed && mode !== 'color') {
    for (const label of model.labels) if (!Number.isInteger(label) || label < 0 || label > 10) throw Error('最终模型的牙面标签超出 0–10 范围');
  }
  const colors = new Float32Array(model.nv * 3), color = new THREE.Color();
  for (let i = 0; i < model.nv; i++) {
    const label = model.labels[i];
    if (auto && $('auto-hole-highlight')?.checked && ranges.some(([start,end]) => Math.floor(i / 3) >= start && Math.floor(i / 3) < end)) color.set('#ff981f');
    else if (removed) color.set('#ffa326');
    else if (mode === 'color') color.setRGB(model.rgb[i * 3],model.rgb[i * 3 + 1],model.rgb[i * 3 + 2]).convertSRGBToLinear();
    else if (mode === 'reconstruction') color.set(reconstructionSession?.patchVertices?.[i] ? '#ff981f' : '#b2becb');
    else if (mode === 'grey' || mode === 'repair') color.set('#b2becb');
    else if (mode === 'shoulder') setColor(color,SHOULDER_IDS.includes(label) ? paletteColor(label) : '#758698');
    else setColor(color,paletteColor(label));
    color.toArray(colors,i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(model.positions,3));
  geometry.setAttribute('normal',new THREE.BufferAttribute(model.normals,3));
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  geometry.setIndex(new THREE.BufferAttribute(model.faces,1));
  const material = new THREE.MeshStandardMaterial({vertexColors:true,roughness:.85,metalness:0,side:THREE.DoubleSide,wireframe:$('wire').checked});
  if (mode === 'repair') { material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 1; }
  const mesh = new THREE.Mesh(geometry,material); mesh.name = key; panel.group.add(mesh);
  if (!removed) {
    panel.host.dataset.modelKey = key;
    panel.renderer.domElement.dataset.modelKey = key;
    $(`${panel.id}-detail`).textContent = `${model.nv.toLocaleString()} 顶点 · ${model.nf.toLocaleString()} 三角面`;
  }
  panel.renderer.domElement.hidden = false;
  $(`${panel.id}-empty`).hidden = true;
}
function validBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 2 && bounds.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)) && bounds[0].every((value,i) => value <= bounds[1][i]);
}
function fit(boundsOverride = null) {
  if (!current) return;
  const bounds = new THREE.Box3();
  if (validBounds(boundsOverride)) bounds.union(new THREE.Box3(new THREE.Vector3(...boundsOverride[0]),new THREE.Vector3(...boundsOverride[1])));
  else {
    if (validBounds(current.bounds)) bounds.union(new THREE.Box3(new THREE.Vector3(...current.bounds[0]),new THREE.Vector3(...current.bounds[1])));
    for (const panel of panels) bounds.expandByObject(panel.group);
  }
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new THREE.Vector3()), radius = Math.max(validBounds(boundsOverride) ? 1.4 : .1,bounds.getSize(new THREE.Vector3()).length() / 2);
  const halfAngle = Math.min(...panels.map(panel => {
    const vertical = THREE.MathUtils.degToRad(panel.camera.fov) / 2;
    return Math.min(vertical,Math.atan(Math.tan(vertical) * panel.camera.aspect));
  }));
  const distance = radius / Math.sin(halfAngle) * 1.08, direction = new THREE.Vector3(...directions[view]).normalize();
  syncing = true;
  for (const panel of panels) {
    panel.controls.target.copy(center); panel.camera.position.copy(center).addScaledVector(direction,distance);
    panel.camera.up.set(0,['top','bottom'].includes(view) ? 1 : 0,['top','bottom'].includes(view) ? 0 : 1);
    panel.camera.near = Math.max(.005,distance / 1000); panel.camera.far = Math.max(1000,distance + radius * 10);
    panel.camera.updateProjectionMatrix(); panel.camera.lookAt(center); panel.controls.update(); draw(panel);
  }
  syncing = false;
  for (const button of $('views').querySelectorAll('[data-view]')) button.setAttribute('aria-pressed',String(button.dataset.view === view));
}
function updateUrl() {
  if (!current) return;
  const url = new URL(location.href);
  url.searchParams.set('mode',$('display-mode').value); url.searchParams.set('view',view);
  if (filter === 'all') url.searchParams.delete('fdi'); else url.searchParams.set('fdi',filter);
  if ($('removed').checked) url.searchParams.set('removed','1'); else url.searchParams.delete('removed');
  url.hash = current.id; history.replaceState(null,'',url);
}
function makeLegend() {
  $('legend').replaceChildren();
  const mode = $('display-mode').value;
  const shoulders = SHOULDER_IDS.map(id => [SHOULDER_NAMES[id],paletteColor(id)]);
  let items = mode === 'color' ? [['扫描原色','#bbd6d7']] : ['grey','repair'].includes(mode) ? [['最终牙体','#b2becb']] : mode === 'shoulder' ? [['其余牙体','#758698'],...shoulders] : [[Number(current.prep_fdi) === 11 ? '切端' : '咬合面',paletteColor(1)],['唇 / 颊侧',paletteColor(2)],['舌侧',paletteColor(3)],['近中',paletteColor(4)],['远中',paletteColor(5)],...shoulders];
  if ($('removed').checked && available(current.models?.[removedKey()])) items.push([removedName(),'#ffa326']);
  if (autoHoleReview()) {
    if (mode === 'segmentation' && (!autoHoleBoundaryLabels() || autoHoleReview().report?.label_assignment?.unresolved_faces > 0)) items.push([autoHoleBoundaryLabels() ? '未知 / 缺少有效分区边界' : '估计补面 / 未知标签 0',paletteColor(0)]);
    if ($('auto-hole-highlight')?.checked && autoHoleRanges().length) items.push(['自动估计补面来源（非组织标签）','#ff981f']);
  }
  for (const [name,color] of items) {
    const item = document.createElement('span'), swatch = document.createElement('i'), resolved = new THREE.Color();
    swatch.className = 'swatch'; setColor(resolved,color); swatch.style.backgroundColor = `#${resolved.getHexString()}`;
    item.append(swatch,document.createTextNode(name)); $('legend').append(item);
  }
}
async function render(doFit = false) {
  const ticket = ++serial, selected = current, mode = $('display-mode').value;
  const auto = autoHoleReview(selected);
  const colorMode = mode === 'color', trial = mode === 'candidate', diagnostic = mode === 'repair', accepted = selected.platform_report?.candidate_accepted;
  updateRemovedControl();
  const whole = diagnostic && $('reconstruction').checked && reconstructionSession?.ready && reconstructionSession.item === selected;
  const overlayKey = removedKey(), leftKey = whole ? 'after' : colorMode ? 'input' : 'before', rightKey = whole ? 'reconstruction' : trial ? 'candidate' : colorMode ? 'refined' : 'after';
  const descriptor = key => key === 'reconstruction' ? selected.hole_reconstruction?.model : selected.models?.[key];
  $('platform-policy').hidden = !!auto || diagnostic;
  $('repair-diagnostic').hidden = !!auto || !diagnostic;
  $('reconstruction-controls').hidden = !!auto || !diagnostic;
  if (diagnostic) $('hole-details').open = true;
  $('platform-policy').dataset.state = trial && !available(selected.models?.candidate) ? 'missing' : accepted === true ? 'accepted' : accepted === false ? 'rejected' : 'unavailable';
  $('platform-policy').style.borderLeftColor = accepted === false ? '#ffbf69' : '';
  $('platform-policy').textContent = trial && !available(selected.models?.candidate) ? '本例没有颈缘试验候选产物，右侧不可用；不会以正式结果或基线替代。' : accepted === false ? trial ? '未采用的试验结果；正式结果请切换最终分割。右侧仅显示实际生成的颈缘候选。' : '本轮颈缘候选未采用。正式产物与阶段输出按其真实文件显示，不据此推断与基线完全一致。' : accepted === true ? trial ? '该颈缘候选已采用；当前显示真实候选，正式最终产物请切换最终分割。' : '本轮颈缘候选已采用，具体删除、重标和细分状态分别记录在下方。' : '颈缘候选采用状态不可用；不能据此判断是否修改或是否保留基线。';
  $('fatal').hidden = true; $('status').textContent = '正在载入真实模型…';
  $('left-label').textContent = whole ? `${versionName('after')} 正式原模型（未修补）` : modelName(leftKey); $('right-label').textContent = whole ? '人工重建副本（含估计面）' : modelName(rightKey);
  $('mode-note').textContent = whole ? `人工重建独立对照：左侧是 ${versionName('after')} 正式原模型，右侧完整替换为人工重建副本。橙色为估计面（标签 0），不是肩台；重建同时移除原局部皱褶面，不能叠加到原面上。取消勾选即返回原始 ${versionName('before')} / ${versionName('after')} 孔洞诊断。` : diagnostic ? `孔洞诊断：左侧为 ${versionName('before')}，右侧为 ${versionName('after')} 的正式灰色牙体；黄色线与点仅标记已核验报告的内部孔边界，不表示已经补好。主颈部开放口不突出显示。` : trial ? `左侧为 ${versionName('before')} 真实最终分割，右侧为本轮实际颈缘候选。下方与基线的比较仍指正式产物，不代表候选比较。` : colorMode ? '同次运行的颈缘阶段原色对照：左侧为实际颈缘输入，右侧为实际颈缘输出；它不是两个版本的最终原色恢复。' : `最终分割模式：左侧读取 ${versionName('before')} 的真实最终牙体与标签，右侧读取 ${versionName('after')} 实际采用的最终产物。`;
  if (auto) {
    $('left-label').textContent = '补面前 · 原始分割'; $('right-label').textContent = '自动补面后 · 完整模型';
    $('mode-note').textContent = '左侧是原始分割，右侧默认加载自动补面后的完整模型。保留面标签不变。' + autoHoleLabelNote();
  }
  const pair = [[left,leftKey],[right,rightKey]];
  for (const [panel,key] of pair) clear(panel,available(descriptor(key)) ? '模型加载中…' : `本例无${modelName(key)}产物`);
  makeLegend();
  if (whole) { const item = document.createElement('span'), swatch = document.createElement('i'); swatch.className = 'swatch'; swatch.style.backgroundColor = '#ff981f'; item.append(swatch,document.createTextNode('人工估计面（标签 0，不作肩台证据）')); $('legend').append(item); }
  const results = await Promise.allSettled(pair.map(async ([,key]) => available(descriptor(key)) ? readModel(descriptor(key)) : null));
  if (ticket !== serial) return;
  let loaded = 0; const errors = [];
  for (let i = 0; i < pair.length; i++) {
    const [panel,key] = pair[i], result = results[i];
    if (result.status === 'rejected') { clear(panel,'模型读取失败，未显示替代结果'); errors.push(result.reason); continue; }
    if (!result.value) continue;
    try { addModel(panel,result.value,key,whole && key === 'reconstruction' ? 'reconstruction' : mode); loaded++; }
    catch (error) { clear(panel,'模型标签无效，未显示替代结果'); errors.push(error); }
  }
  if ($('removed').checked && available(selected.models?.[overlayKey]) && right.host.dataset.modelKey) {
    try {
      const removed = await readModel(selected.models[overlayKey]);
      if (ticket !== serial) return;
      addModel(right,removed,overlayKey,mode,true);
    } catch (error) { errors.push(error); }
  }
  if (ticket !== serial) return;
  if (!auto) { drawHoleOverlays(); drawHoleBoundaries(); updateHoleControls(); }
  if (doFit) fit(auto && query.get('focus') === 'repair' ? auto.patch_bounds : null); else for (const panel of panels) draw(panel);
  if (errors.length) showError(errors.map(error => error.message || String(error)).join('；'));
  $('status').textContent = `${loaded === 2 && !errors.length ? '已加载' : '部分结果不可用'} · ${modeNames[mode]} · ${loaded}/2 幅模型`;
}
function duplicatesOf(item) {
  return Array.isArray(item.duplicate_ids) ? item.duplicate_ids.map(value => typeof value === 'string' ? value : value?.id).filter(Boolean).filter(id => id !== item.id) : [];
}
function displayText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : value == null ? '' : JSON.stringify(value);
}
function appendLink(parent,url,label) {
  if (typeof url !== 'string' || !url) return;
  const resolved = new URL(url,location.href);
  if (!['http:','https:'].includes(resolved.protocol)) return;
  const link = document.createElement('a'); link.href = resolved.href; link.textContent = label;
  link.setAttribute('download',''); parent.append(link);
}
function statusRow(parent,key,label,value,kind = 'modified',unavailable = '不可用（未提供）') {
  const row = document.createElement('div'), term = document.createElement('dt'), definition = document.createElement('dd');
  term.textContent = label;
  definition.dataset.field = key;
  definition.dataset.state = typeof value === 'boolean' ? String(value) : 'unavailable';
  const captions = {equal:['不同','一致'],modified:['未修改','已修改'],changed:['未变化','已变化'],removed:['无裁除','有裁除'],tessellated:['未细分','已细分'],used:['未使用','已使用']};
  definition.textContent = typeof value !== 'boolean' ? unavailable : (captions[kind] || captions.modified)[Number(value)];
  row.append(term,definition); parent.append(row);
}
function quantityRow(parent,key,label,value) {
  const row = document.createElement('div'), term = document.createElement('dt'), definition = document.createElement('dd');
  term.textContent = label; definition.dataset.field = key;
  const known = typeof value === 'number' && Number.isFinite(value) && value >= 0;
  definition.dataset.state = known ? 'available' : 'unavailable';
  definition.textContent = known ? `${value.toFixed(3)} mm²` : '不可用（未提供）';
  row.append(term,definition); parent.append(row);
}
function updateAttemptRecord() {
  const report = current.platform_report, fields = ['candidate_attempts','fallback_used','selected_evidence_level'];
  const archive = Array.isArray(current.attempt_archive) ? current.attempt_archive : [];
  const present = (report && fields.some(key => Object.hasOwn(report,key))) || archive.length > 0;
  $('attempt-details').hidden = !present; $('attempt-status').replaceChildren();
  $('attempt-report').textContent = report ? JSON.stringify(Object.fromEntries(fields.filter(key => Object.hasOwn(report,key)).map(key => [key,report[key]])),null,2) : '未提供';
  $('attempt-downloads').replaceChildren();
  for (const attempt of archive) {
    const block = document.createElement('section'), heading = document.createElement('h3'), links = document.createElement('div');
    heading.textContent = `${displayText(attempt.evidence_level) || '未标明证据级别'} · ${displayText(attempt.status) || '状态未提供'} · ${attempt.candidate_accepted === true ? '该次候选通过' : attempt.candidate_accepted === false ? '该次候选未通过' : '候选状态不可用'}`;
    links.className = 'downloads'; appendLink(links,attempt.report_url,'该次尝试真实报告');
    for (const file of Array.isArray(attempt.files) ? attempt.files : []) appendLink(links,file.url,displayText(file.path) || '归档文件');
    block.append(heading,links); $('attempt-downloads').append(block);
  }
  if (!present) return;
  statusRow($('attempt-status'),'fallback_used','是否使用回退',report?.fallback_used,'used');
  const row = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
  term.textContent = '实际采用的证据级别'; value.dataset.field = 'selected_evidence_level';
  value.dataset.state = report?.selected_evidence_level == null ? 'unavailable' : 'available';
  value.textContent = report?.selected_evidence_level == null ? '不可用（未提供）' : displayText(report?.selected_evidence_level);
  row.append(term,value); $('attempt-status').append(row);
}
function resetHoleReview() {
  holeSession = {item:current,selected:new Set(),undo:[],ready:false,busy:false};
  resetReconstructionReview();
  $('hole-list').replaceChildren(); $('hole-downloads').replaceChildren();
  $('hole-status').dataset.state = 'unavailable';
  $('hole-status').textContent = '本例未提供孔洞检测 / 修补清单；不能据此判断没有孔洞。';
  $('hole-report').textContent = current.hole_repair == null ? '未提供' : JSON.stringify(current.hole_repair,null,2);
  $('hole-selection-note').textContent = '当前显示正式分割结果，没有添加修补片。';
  for (const key of ['hole-undo','hole-clear','hole-download']) $(key).disabled = true;
  const downloads = current.downloads || {};
  for (const [key,label] of [['hole_repair_report_json_url','孔洞原始检测记录 JSON'],['hole_repair_mesh_ply_url','全部修补候选网格（不等于已选择）'],['hole_repair_provenance_json_url','双源追溯与候选范围 JSON'],['hole_repair_provenance_npz_url','原始逐面来源数组 NPZ']]) appendLink($('hole-downloads'),downloads[key],label);
  if (current.hole_repair?.status === 'not_generated') {
    $('hole-status').dataset.state = 'not_generated';
    $('hole-status').textContent = `孔洞检测与修补候选尚未生成：${displayText(current.hole_repair.reason) || '未提供进一步说明'}。`;
  } else if (current.hole_repair != null) {
    $('hole-status').textContent = '孔洞报告已提供，预览必须完成源网格与补片范围核验后才可选择。';
    $('hole-status').dataset.state = 'pending_validation';
    loadHoleReview(holeSession).catch(error => {
      if (holeSession?.item !== current || holeSession.item !== error.item && error.item) return;
      $('hole-status').dataset.state = 'error';
      $('hole-status').textContent = `修补预览不可用：${error.message}。正式结果仍按实际文件显示。`;
      if ($('display-mode').value === 'repair') $('repair-diagnostic').textContent = $('hole-status').textContent + ' 未显示孔边界。';
    });
  }
}
const holeColors = {restored_original_post:'#00f1ff',synthetic_estimate:'#ff39dd'};
const holeNames = {restored_original_post:'原扫描恢复预览',synthetic_estimate:'估计补片预览'};
function holeReason(reason) {
  return ({cannot_triangulate_without_altering_rim:'无法在保留原孔边的情况下安全构造补片',main_cervical_boundary_must_remain_open:'主颈部开放口需保留',ambiguous_cervical_boundary:'主颈缘位置不明确',no_unique_bounded_uncovered_source_patch:'无法确定唯一的未覆盖原扫描面片',source_scan_has_no_faces_across_hole:'原扫描在该孔边也缺少对侧面片',source_patch_winding_conflicts_with_current_mesh:'原扫描面片与当前孔边绕序冲突',large_gap_guard:'缺口超出局部修补范围',non_simple_or_inconsistent_boundary:'边界不是可安全修补的单一闭环'})[reason] || displayText(reason);
}
function assertHole(condition,message) { if (!condition) throw Error(message); }
async function sha256(buffer) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(value => value.toString(16).padStart(2,'0')).join(''); }
async function checkedHoleResource(url,identity) {
  assertHole(typeof url === 'string' && /^[a-f0-9]{64}$/i.test(identity?.sha256 || ''),'缺少修补资源的准确来源');
  const response = await fetch(modelUrl(url));
  assertHole(response.ok,`修补资源 HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  assertHole(bytes.byteLength === identity.bytes && await sha256(bytes) === identity.sha256,'修补资源哈希或长度不符');
  return bytes;
}
function holeRange(hole) { return hole.patch_face_range ?? hole.output_face_range; }
function validateHoleBindings(report,provenance,item) {
  const checks = item.source_checks, binding = report.canonical_binding, files = report.source_files_sha256;
  assertHole(report.catalog_schema === 'hole-repair-catalog-v1' && binding && files,'缺少正式孔洞目录来源绑定');
  assertHole(binding.mesh_sha256 === checks.after.ply.sha256 && binding.vertex_count === report.source_vertex_count && binding.face_count === report.source_face_count && binding.labels_sha256 === checks.after.labels?.sha256,'孔洞目录与正式模型/标签身份不符');
  const hashes = Object.values(files);
  for (const key of ['mesh_sha256','labels_sha256','frame_sha256','step4_provenance_sha256']) assertHole(/^[a-f0-9]{64}$/i.test(binding[key] || '') && hashes.includes(binding[key]),'canonical 来源文件绑定不完整');
  assertHole(binding.step4_provenance_sha256 === checks.after_source_provenance?.sha256 && binding.step4_provenance_sha256 === report.canonical_source_provenance_sha256,'正式模型 Step4 追溯身份不符');
  const raw = report.raw_source_binding;
  if (raw != null) {
    assertHole(raw.transform_direction === 'POST_to_PRE' && raw.transform_applied === true,'原 POST 实际配准方向未确认');
    for (const [key,path] of [['mesh_sha256','mesh_path'],['transform_sha256','transform_path'],['step4_mapping_sha256','step4_mapping_path']]) assertHole(/^[a-f0-9]{64}$/i.test(raw[key] || '') && files[raw[path]] === raw[key],'原 POST / 实际配准 / 提取映射来源不完整');
  }
  if (report.holes.some(h => h.eligible && h.source_kind === 'restored_original_post' && holeRange(h) != null)) assertHole(raw && report.source_restoration_checked === true,'恢复片没有经过原 POST 与实际配准绑定检查');
  const sameFiles = provenance.source_files_sha256 && Object.keys(files).length === Object.keys(provenance.source_files_sha256).length && Object.entries(files).every(([path,sha]) => provenance.source_files_sha256[path] === sha);
  assertHole(provenance.schema === 'hole-repair-catalog-provenance-v1' && provenance.source_mesh_sha256 === report.source_mesh_sha256 && provenance.canonical_face_count === report.source_face_count && sameFiles,'逐面追溯与孔洞报告双源身份不符');
  assertHole(report.pipeline_outputs_modified === false && report.measurement_eligible === false && provenance.pipeline_outputs_modified === false && provenance.measurement_eligible === false,'修补目录未声明为独立、非测量真值衍生');
  const total = item.models.repair?.faces ?? report.source_face_count;
  const arrays = ['face_origin','synthetic_face_mask','step4_source_faces','step4_corner_barycentric','raw_source_faces','raw_corner_barycentric'];
  assertHole(arrays.every(key => Array.isArray(provenance[key]) && provenance[key].length === total),'逐面来源数组长度与真实候选网格不符');
  const weights = row => Array.isArray(row) && row.length === 3 && row.every(r => Array.isArray(r) && r.length === 3 && r.every(Number.isFinite));
  for (let face=0;face<total;face++) {
    const origin = provenance.face_origin[face], source = face < report.source_face_count;
    assertHole([0,1,2].includes(origin) && (source ? origin === 0 : origin !== 0) && provenance.synthetic_face_mask[face] === (origin === 2),'原扫描/恢复/估计面标识不一致');
    assertHole(source ? Number.isInteger(provenance.step4_source_faces[face]) && provenance.step4_source_faces[face] >= 0 && weights(provenance.step4_corner_barycentric[face]) : provenance.step4_source_faces[face] === -1 && provenance.step4_corner_barycentric[face] === null,'Step4 来源被错误分配到补片');
    assertHole(origin === 1 ? Number.isInteger(provenance.raw_source_faces[face]) && provenance.raw_source_faces[face] >= 0 && weights(provenance.raw_corner_barycentric[face]) : provenance.raw_source_faces[face] === -1 && provenance.raw_corner_barycentric[face] === null,'真实原 POST 来源与补片类型不符');
  }
}
async function loadHoleReview(session) {
  const item = session.item, checks = item.source_checks || {}, downloads = item.downloads || {};
  try {
    const reportBytes = await checkedHoleResource(downloads.hole_repair_report_json_url,checks.hole_repair_report);
    const report = JSON.parse(new TextDecoder().decode(reportBytes));
    if (holeSession !== session) return;
    assertHole(report.schema === 'local-hole-repair-v1','孔洞报告版本不受支持');
    assertHole(report.source_mesh_sha256 === checks.after?.ply?.sha256 && item.hole_repair.source_mesh_sha256 === report.source_mesh_sha256,'孔洞报告未绑定本例正式模型');
    assertHole(report.source_vertex_count === item.models.after?.vertices && report.source_face_count === item.models.after?.faces,'孔洞源网格计数不符');
    assertHole(Array.isArray(report.holes) && report.holes.every(h => typeof h.id === 'string' && !!h.id) && new Set(report.holes.map(h => h.id)).size === report.holes.length,'孔洞 ID 缺失或重复');
    const provenanceBytes = await checkedHoleResource(downloads.hole_repair_provenance_json_url,checks.hole_repair_provenance);
    const provenance = JSON.parse(new TextDecoder().decode(provenanceBytes));
    validateHoleBindings(report,provenance,item);
    if (holeSession !== session) return;
    session.report = report; session.reportBytes = reportBytes; session.provenance = provenance; session.provenanceBytes = provenanceBytes;
    const boundaries = report.holes.filter(h => h.kind !== 'protected_cervical' && Array.isArray(h.boundary_vertex_indices) && h.boundary_vertex_indices.length >= 3);
    for (const hole of boundaries) assertHole(hole.boundary_vertex_indices.every(index => Number.isInteger(index) && index >= 0 && index < report.source_vertex_count),'孔边界索引不属于正式源网格');
    if (boundaries.length) {
      await checkedHoleResource(item.models.after.url,checks.after?.bin);
      const after = await readModel(item.models.after);
      if (holeSession !== session) return;
      session.boundaryModel = after; session.boundaries = boundaries;
    }

    const selectable = report.holes.filter(h => h.eligible === true && h.kind === 'candidate' && Object.hasOwn(holeColors,h.source_kind) && holeRange(h) != null);
    if (selectable.length) {
      assertHole(available(item.models.repair),'未提供实际修补候选网格');
      await checkedHoleResource(item.models.repair.url,checks.repair?.bin);
      const [repair,after] = await Promise.all([readModel(item.models.repair),readModel(item.models.after)]);
      if (holeSession !== session) return;
      assertHole(repair.nv >= after.nv && repair.nf >= after.nf && after.positions.every((value,index) => value === repair.positions[index]) && after.faces.every((value,index) => value === repair.faces[index]),'修补网格没有原样保留正式模型的顶点/三角面前缀');
      const assigned = new Set();
      for (const hole of selectable) {
        const range = holeRange(hole);
        assertHole(Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] >= after.nf && range[1] > range[0] && range[1] <= repair.nf,'补片追加面范围无效');
        for (let face=range[0]; face<range[1]; face++) { assertHole(!assigned.has(face),'不同补片追加面重叠'); assigned.add(face); }
        assertHole(hole.synthetic === (hole.source_kind === 'synthetic_estimate'),'补片真实来源与估计标识冲突');
        if (hole.source_kind === 'restored_original_post') assertHole(Array.isArray(hole.source_face_indices) && hole.source_face_indices.length === range[1]-range[0],'恢复片缺少逐面原扫描追溯');
        for (let face=range[0];face<range[1];face++) {
          assertHole(provenance.face_origin[face] === (hole.source_kind === 'restored_original_post' ? 1 : 2),'补片范围与逐面来源不符');
          if (hole.source_kind === 'restored_original_post') assertHole(provenance.raw_source_faces[face] === hole.source_face_indices[face-range[0]],'恢复片逐面原 POST 索引不符');
        }
      }
      assertHole(assigned.size === repair.nf-after.nf,'候选网格含未声明的额外三角面');
      session.repair = repair;
    }
    session.ready = true;
    for (const hole of selectable) if (hole.source_kind === 'restored_original_post' && hole.recommended === true) session.selected.add(hole.id);
    if (holeSession !== session) return;
    $('hole-report').textContent = JSON.stringify(report,null,2); $('hole-status').dataset.state = 'ready';
    $('hole-status').textContent = `已核对 ${report.holes.length} 个边界条目，${selectable.length} 项具有保留原面的追加补片候选。主颈部开放口保留；未宣称整牙闭合。${item.hole_reconstruction ? ' 独立人工重建副本使用上方单独开关，可能移除局部原面。' : ''}`;
    for (const hole of report.holes) {
      const row = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span'), detail = document.createElement('small');
      row.className = 'hole-item'; row.dataset.holeId = hole.id; input.type = 'checkbox'; input.dataset.holeId = hole.id;
      const enabled = selectable.includes(hole); input.dataset.eligible = String(enabled);
      text.textContent = `${hole.id} · ${hole.kind === 'protected_cervical' ? '颈部开放口（保留）' : holeNames[hole.source_kind] || '不可修补边界'}`;
      if (enabled) text.className = hole.source_kind === 'restored_original_post' ? 'hole-kind-restored' : 'hole-kind-synthetic';
      const size = [['perimeter_mm','周长','mm'],['projected_area_mm2','投影面积','mm²']].filter(([key]) => Number.isFinite(hole[key])).map(([key,name,unit]) => `${name} ${hole[key].toFixed(3)} ${unit}`);
      const restoreReasons = hole.source_restoration_assessment?.rejection_reasons;
      detail.textContent = [...size,...(hole.eligible === true && holeRange(hole) == null ? ['候选补片尚未生成，无法勾选'] : []),...(Array.isArray(hole.rejection_reasons) ? hole.rejection_reasons.map(holeReason) : []),...(Array.isArray(restoreReasons) && restoreReasons.length ? ['原扫描恢复：'+restoreReasons.map(holeReason).join('、')] : [])].join(' · ');
      input.onchange = () => { if (holeSession !== session || !enabled) return; session.undo.push([...session.selected]); if (input.checked) session.selected.add(hole.id); else session.selected.delete(hole.id); updateHoleControls(); render(false).catch(showError); };
      label.append(input,text); row.append(label,detail); $('hole-list').append(row);
    }
    updateHoleControls(); await render(false);
  } catch (error) { error.item = item; throw error; }
}
function updateHoleControls() {
  const session = holeSession, canonicalMode = ['segmentation','grey','shoulder','repair'].includes($('display-mode').value);
  const usable = session?.ready && !session.busy && canonicalMode && !$('reconstruction').checked;
  for (const input of $('hole-list').querySelectorAll('input')) { input.checked = !!session?.selected.has(input.dataset.holeId); input.disabled = !usable || input.dataset.eligible !== 'true'; }
  $('hole-undo').disabled = !usable || !session.undo.length;
  $('hole-clear').disabled = !usable || !session.selected.size;
  $('hole-download').disabled = !usable || !session.selected.size;
  if (!session?.ready) return;
  const chosen = session.report.holes.filter(h => session.selected.has(h.id));
  const restored = chosen.filter(h => h.source_kind === 'restored_original_post').length, synthetic = chosen.filter(h => h.source_kind === 'synthetic_estimate').length;
  $('hole-selection-note').textContent = $('reconstruction').checked ? '当前显示完整人工重建副本，不能混叠追加补片；正式模型未修改。' : session.busy ? '正在生成独立修补下载；正式结果不变…' : !canonicalMode ? '当前模式不叠加正式模型的补片；请切换最终分割、灰体、肩台高亮或孔洞诊断查看。' : chosen.length ? `预览选择：原扫描恢复 ${restored} 项、估计补片 ${synthetic} 项。两者均未写回正式结果，均不作为肩台证据。` : '当前显示正式分割结果，没有添加修补片。';
}
function drawHoleOverlays() {
  const session = holeSession;
  if (!session?.ready || !session.repair || right.host.dataset.modelKey !== 'after') return;
  const chosen = session.report.holes.filter(h => session.selected.has(h.id));
  let faceCount = 0;
  for (const hole of chosen) {
    const range = holeRange(hole), geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(session.repair.positions,3));
    geometry.setIndex(new THREE.BufferAttribute(session.repair.faces.slice(range[0]*3,range[1]*3),1)); geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({color:holeColors[hole.source_kind],roughness:.9,side:THREE.DoubleSide,wireframe:$('wire').checked});
    const mesh = new THREE.Mesh(geometry,material); mesh.name = `hole:${hole.id}`; right.group.add(mesh); faceCount += range[1]-range[0];
  }
  right.host.dataset.holeIds = chosen.map(h => h.id).join(','); right.host.dataset.holeFaceCount = String(faceCount);
  if (chosen.length) {
    $('right-label').textContent = `${versionName('after')} 最终分割 + ${chosen.length} 项独立修补预览`;
    $('right-detail').textContent += ` · 另加 ${faceCount.toLocaleString()} 个独立预览三角面`;
    $('mode-note').textContent += ' 右侧另叠加所选修补预览，未写入正式结果。';
    for (const kind of Object.keys(holeColors)) if (chosen.some(h => h.source_kind === kind)) {
      const item = document.createElement('span'), swatch = document.createElement('i'); swatch.className = 'swatch'; swatch.style.backgroundColor = holeColors[kind]; item.append(swatch,document.createTextNode(holeNames[kind])); $('legend').append(item);
    }
  }
}
// Download uses source-coordinate PLY bytes, never the float32 display BIN or a reverse camera transform.
function resetReconstructionReview() {
  const item = current, bundle = item.hole_reconstruction;
  reconstructionSession = {item,ready:false}; $('reconstruction').checked = false; $('reconstruction').disabled = true;
  $('reconstruction-downloads').replaceChildren(); $('reconstruction-note').textContent = '本例没有独立人工重建副本；正式分割和孔洞拒绝记录保持原样。';
  if (!bundle) return;
  const session = reconstructionSession;
  $('reconstruction-note').textContent = '人工重建副本正在核验来源，完成前不能预览。';
  (async () => {
    assertHole(bundle.schema === 'local-hole-reconstruction-review-v1' && available(bundle.model),'人工重建清单或模型不可用');
    const checks = bundle.source_checks || {}, downloads = bundle.downloads || {};
    const bytes = await checkedHoleResource(downloads.report_json_url,checks.report), report = JSON.parse(new TextDecoder().decode(bytes));
    assertHole(report.schema === 'local-hole-reconstruction-v1' && report.representation === 'full_replacement' && report.accepted === true,'人工重建没有通过独立全替换候选检查');
    assertHole(report.canonical_modified === false && report.applied_to_pipeline === false && report.measurement_eligible === false && report.manual_estimate === true,'人工重建未声明独立估计与测量隔离');
    if (data.runtime_algorithm_sources_sha256) assertHole(report.runtime_algorithm_sources_sha256 === data.runtime_algorithm_sources_sha256 && report.candidate_run_root === data.candidate_run_root,'人工重建不属于当前版本来源');
    const binding = report.canonical_binding, inputs = Object.values(report.source_files_sha256 || {});
    assertHole(binding && binding.mesh_sha256 === item.source_checks?.after?.ply?.sha256 && binding.labels_sha256 === item.source_checks?.after?.labels?.sha256 && binding.trace_sha256 === item.source_checks?.after_source_provenance?.sha256,'人工重建未绑定本例正式网格、标签与原面追溯');
    assertHole(binding.vertex_count === item.models.after.vertices && binding.face_count === item.models.after.faces,'人工重建绑定的正式网格计数不符');
    assertHole([binding.mesh_sha256,binding.labels_sha256,binding.trace_sha256,binding.frame_sha256].every(value => /^[a-f0-9]{64}$/.test(value) && inputs.includes(value)),'人工重建缺少实际输入来源 SHA');
    for (const [key,identity,file] of [['mesh_ply_url',checks.mesh?.ply,'reconstruction_mesh.ply'],['labels_json_url',checks.labels,'reconstruction_labels.json'],['provenance_npz_url',checks.provenance,'reconstruction_provenance.npz']]) {
      assertHole(identity && report.outputs_sha256?.[file] === identity.sha256,'人工重建输出与实际报告 SHA 不符');
      await checkedHoleResource(downloads[key],identity);
    }
    if (checks.preview || downloads.preview_ply_url) { assertHole(report.outputs_sha256?.['reconstruction_preview.ply'] === checks.preview?.sha256,'重建原色预览与真实报告不符'); await checkedHoleResource(downloads.preview_ply_url,checks.preview); }
    await checkedHoleResource(bundle.model.url,checks.mesh?.bin);
    const model = await readModel(bundle.model), range = report.patch_face_range;
    assertHole(Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] >= 0 && range[1] <= model.nf && range[1]-range[0] === report.synthetic_faces_added && model.nf === report.output_face_count,'人工重建估计面范围与模型不符');
    assertHole(new Set(model.faces).size === model.faces.length,'人工重建展示网格未提供独立面顶点，不能准确标色');
    const patchVertices = new Uint8Array(model.nv);
    for (let face=range[0];face<range[1];face++) for (let corner=0;corner<3;corner++) patchVertices[model.faces[face*3+corner]] = 1;
    if (reconstructionSession !== session) return;
    session.report = report; session.patchVertices = patchVertices; session.ready = true; $('reconstruction').disabled = false;
    $('reconstruction-note').textContent = `可人工查看独立重建副本：移除 ${Number.isInteger(report.source_faces_removed) ? report.source_faces_removed : '报告所记的'} 个原局部三角面，加入 ${Number.isInteger(report.synthetic_faces_added) ? report.synthetic_faces_added : '报告所记的'} 个估计三角面。未改动正式扫描结果，也不进入肩台测量。默认不预览。`;
    for (const [key,label] of [['mesh_ply_url','独立人工重建网格 PLY'],['labels_json_url','人工重建标签（估计面为 0）'],['provenance_npz_url','保留面 / 估计面来源 NPZ'],['report_json_url','人工重建原始记录 JSON']]) appendLink($('reconstruction-downloads'),downloads[key],label);
  })().catch(error => { if (reconstructionSession === session) $('reconstruction-note').textContent = `人工重建预览不可用：${error.message}。正式结果保持原样。`; });
}

function drawHoleBoundaries() {
  if ($('display-mode').value !== 'repair') return;
  const session = holeSession, diagnostic = $('repair-diagnostic');
  if ($('reconstruction').checked && reconstructionSession?.ready) { diagnostic.textContent = '当前是独立人工重建预览；原来的自动补片拒绝记录仍保留在下方，不代表已通过自动修补。橙色估计面未经牙面或肩台分割。'; return; }
  if (!session?.ready || right.host.dataset.modelKey !== 'after') {
    diagnostic.textContent = $('hole-status').textContent + ' 尚未显示孔边界。';
    return;
  }
  const holes = session.boundaries || [], model = session.boundaryModel;
  const reasons = session.report.holes.filter(h => h.kind !== 'protected_cervical').map(h => {
    const source = h.source_restoration_assessment?.rejection_reasons;
    const parts = [...(h.rejection_reasons || []).map(holeReason),...(Array.isArray(source) && source.length ? ['原扫描恢复：'+source.map(holeReason).join('、')] : [])];
    return parts.length ? `${h.id}：${parts.join('；')}` : `${h.id}：按本条目实际候选状态查看，检测边界不等于已修补`;
  });
  diagnostic.textContent = `已核验并标记 ${holes.length} 个内部孔边界。${session.selected.size ? '所选补片为独立预览，正式结果不变。' : '当前没有添加修补片。'}${reasons.length ? ' '+reasons.join('。')+'。' : ' 主颈部开放口不作为内部小孔突出。'}`;
  if (!model) return;
  let count = 0;
  for (const hole of holes) {
    const positions = new Float32Array(hole.boundary_vertex_indices.length * 3);
    hole.boundary_vertex_indices.forEach((index,i) => positions.set(model.positions.subarray(index*3,index*3+3),i*3));
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    const line = new THREE.LineLoop(geometry,new THREE.LineBasicMaterial({color:'#ffdf35',depthTest:true}));
    line.name = `hole-boundary:${hole.id}`; line.renderOrder = 3; right.group.add(line);
    const dots = new THREE.Points(geometry.clone(),new THREE.PointsMaterial({color:'#ffdf35',size:2.5,sizeAttenuation:false,depthTest:true}));
    dots.name = `hole-boundary-points:${hole.id}`; dots.renderOrder = 4; right.group.add(dots); count += hole.boundary_vertex_indices.length;
  }
  right.host.dataset.holeBoundaryIds = holes.map(h => h.id).join(',');
  right.host.dataset.holeBoundaryVertexCount = String(count);
  if (holes.length) {
    const item = document.createElement('span'), swatch = document.createElement('i'); swatch.className = 'swatch'; swatch.style.backgroundColor = '#ffdf35';
    item.append(swatch,document.createTextNode('已检测内部孔边界（未表示已修补）')); $('legend').append(item);
  }
}

function parseRepairPly(buffer) {
  const prefix = new TextDecoder().decode(buffer.slice(0,Math.min(buffer.byteLength,65536))), match = /end_header\r?\n/.exec(prefix);
  assertHole(match && prefix.startsWith('ply'),'修补 PLY 头无效');
  const headerText = prefix.slice(0,match.index+match[0].length), offset = new TextEncoder().encode(headerText).byteLength, header = headerText.split(/\r?\n/);
  let format, element; const elements = [];
  for (const line of header) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'format') format = fields[1];
    if (fields[0] === 'element') { element = {name:fields[1],count:Number(fields[2]),properties:[]}; elements.push(element); }
    if (fields[0] === 'property') { assertHole(element,'PLY 属性没有所属元素'); element.properties.push(fields[1] === 'list' ? {name:fields[4],type:fields[3],countType:fields[2]} : {name:fields[2],type:fields[1]}); }
  }
  assertHole(['ascii','binary_little_endian','binary_big_endian'].includes(format),'不支持的 PLY 编码');
  assertHole(elements.length === 2 && elements[0].name === 'vertex' && elements[1].name === 'face' && elements.every(e => Number.isInteger(e.count) && e.count >= 0),'PLY 不是已约定的顶点/三角面模型');
  const types = {char:['getInt8',1],int8:['getInt8',1],uchar:['getUint8',1],uint8:['getUint8',1],short:['getInt16',2],int16:['getInt16',2],ushort:['getUint16',2],uint16:['getUint16',2],int:['getInt32',4],int32:['getInt32',4],uint:['getUint32',4],uint32:['getUint32',4],float:['getFloat32',4],float32:['getFloat32',4],double:['getFloat64',8],float64:['getFloat64',8]};
  const view = new DataView(buffer), ascii = format === 'ascii' ? new TextDecoder().decode(buffer.slice(offset)).trim().split(/\s+/) : null;
  let cursor = offset, token = 0;
  function number(type) {
    assertHole(Object.hasOwn(types,type),'不支持的 PLY 属性类型');
    const [method,size] = types[type];
    const value = ascii ? Number(ascii[token++]) : view[method](cursor,format !== 'binary_big_endian');
    if (!ascii) cursor += size;
    assertHole(Number.isFinite(value),'PLY 包含非有限或不完整数值'); return value;
  }
  for (const e of elements) {
    e.rows = [];
    for (let i=0;i<e.count;i++) {
      const row = {};
      for (const property of e.properties) {
        if (property.countType) {
          const count = number(property.countType); assertHole(Number.isInteger(count) && count >= 0 && count <= 1024,'PLY 列表长度无效');
          row[property.name] = Array.from({length:count},() => number(property.type));
        } else row[property.name] = number(property.type);
      }
      e.rows.push(row);
    }
  }
  const [vertices,faces] = elements, indexKey = faces.properties.find(p => p.countType && ['vertex_indices','vertex_index'].includes(p.name))?.name;
  assertHole(indexKey && vertices.rows.every(v => ['x','y','z'].every(k => Number.isFinite(v[k]))) && faces.rows.every(f => f[indexKey].length === 3 && f[indexKey].every(i => Number.isInteger(i) && i >= 0 && i < vertices.count)),'PLY 顶点或三角面索引无效');
  return {vertices,faces,indexKey};
}
function selectedRepairPly(parsed,report,holes) {
  const faceIds = Array.from({length:report.source_face_count},(_,i) => i), origin = Array(report.source_face_count).fill(0);
  for (const hole of holes) for (let face=holeRange(hole)[0];face<holeRange(hole)[1];face++) { faceIds.push(face); origin.push(hole.source_kind === 'restored_original_post' ? 1 : 2); }
  const vertexIds = Array.from({length:report.source_vertex_count},(_,i) => i), remap = new Map(vertexIds.map(i => [i,i]));
  for (const face of faceIds) for (const id of parsed.faces.rows[face][parsed.indexKey]) if (!remap.has(id)) { remap.set(id,vertexIds.length); vertexIds.push(id); }
  const properties = e => e.properties.map(p => p.countType ? `property list ${p.countType} ${p.type} ${p.name}` : `property ${p.type} ${p.name}`);
  assertHole(!parsed.faces.properties.some(p => p.name === 'repair_origin'),'输入 PLY 已含修补来源属性，不能混合衍生版本');
  const lines = ['ply','format ascii 1.0','comment Independent manual repair; repair_origin 0 canonical 1 restored POST 2 synthetic estimate',`element vertex ${vertexIds.length}`,...properties(parsed.vertices),`element face ${faceIds.length}`,...properties(parsed.faces),'property uchar repair_origin','end_header'];
  const values = (row,props) => props.flatMap(p => p.countType ? [row[p.name].length,...row[p.name]] : [row[p.name]]);
  for (const index of vertexIds) lines.push(values(parsed.vertices.rows[index],parsed.vertices.properties).join(' '));
  faceIds.forEach((index,i) => { const row = {...parsed.faces.rows[index],[parsed.indexKey]:parsed.faces.rows[index][parsed.indexKey].map(id => remap.get(id))}; lines.push([...values(row,parsed.faces.properties),origin[i]].join(' ')); });
  return {bytes:new TextEncoder().encode(lines.join('\n')+'\n'),faceIds,vertexIds,origin};
}
function zipStored(entries) {
  const encode = new TextEncoder(), local = [], central = []; let offset = 0;
  const crc = bytes => { let value = -1; for (const byte of bytes) { value ^= byte; for (let bit=0;bit<8;bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ -1) >>> 0; };
  for (const [filename,bytes] of entries) {
    const name = encode.encode(filename), hash = crc(bytes), record = new Uint8Array(30+name.length), v = new DataView(record.buffer);
    v.setUint32(0,0x04034b50,true); v.setUint16(4,20,true); v.setUint16(6,0x0800,true); v.setUint32(14,hash,true); v.setUint32(18,bytes.length,true); v.setUint32(22,bytes.length,true); v.setUint16(26,name.length,true); record.set(name,30); local.push(record,bytes);
    const directory = new Uint8Array(46+name.length), d = new DataView(directory.buffer);
    d.setUint32(0,0x02014b50,true); d.setUint16(4,20,true); d.setUint16(6,20,true); d.setUint16(8,0x0800,true); d.setUint32(16,hash,true); d.setUint32(20,bytes.length,true); d.setUint32(24,bytes.length,true); d.setUint16(28,name.length,true); d.setUint32(42,offset,true); directory.set(name,46); central.push(directory); offset += record.length+bytes.length;
  }
  const end = new Uint8Array(22), v = new DataView(end.buffer); v.setUint32(0,0x06054b50,true); v.setUint16(8,entries.length,true); v.setUint16(10,entries.length,true); v.setUint32(12,central.reduce((n,b) => n+b.length,0),true); v.setUint32(16,offset,true);
  return new Blob([...local,...central,end],{type:'application/zip'});
}
async function downloadSelectedRepair() {
  const session = holeSession;
  if (!session?.ready || !session.selected.size || session.busy) return;
  const selected = session.report.holes.filter(h => session.selected.has(h.id));
  session.busy = true; updateHoleControls();
  try {
    const item = session.item, checks = item.source_checks, downloads = item.downloads;
    const [plyBytes,provenanceBytes] = await Promise.all([checkedHoleResource(downloads.hole_repair_mesh_ply_url,checks.repair.ply),checkedHoleResource(downloads.hole_repair_provenance_json_url,checks.hole_repair_provenance)]);
    if (holeSession !== session) return;
    const provenance = JSON.parse(new TextDecoder().decode(provenanceBytes));
    validateHoleBindings(session.report,provenance,item);
    const parsed = parseRepairPly(plyBytes);
    assertHole(parsed.vertices.count === item.models.repair.vertices && parsed.faces.count === item.models.repair.faces,'下载 PLY 与修补候选模型计数不符');
    const result = selectedRepairPly(parsed,session.report,selected), synthetic = result.origin.includes(2), suffix = synthetic ? 'synthetic-repair' : 'source-restored';
    const record = {schema:'manual-selected-hole-repair-v1',source_mesh_sha256:session.report.source_mesh_sha256,repair_mesh_sha256:checks.repair.ply.sha256,
      selected_hole_ids:selected.map(h => h.id),selected_holes:selected,face_origin:result.origin,synthetic_face_mask:result.origin.map(value => value === 2),
      canonical_binding:session.report.canonical_binding,raw_source_binding:session.report.raw_source_binding,
      step4_source_faces:result.faceIds.map(i => provenance.step4_source_faces[i]),step4_corner_barycentric:result.faceIds.map(i => provenance.step4_corner_barycentric[i]),
      raw_source_faces:result.faceIds.map(i => provenance.raw_source_faces[i]),raw_corner_barycentric:result.faceIds.map(i => provenance.raw_corner_barycentric[i]),
      original_vertex_count:session.report.source_vertex_count,original_face_count:session.report.source_face_count,
      output_vertex_to_repair_vertex:result.vertexIds,output_face_to_repair_face:result.faceIds,source_report_sha256:checks.hole_repair_report.sha256,source_provenance_sha256:checks.hole_repair_provenance.sha256,
      original_vertices_preserved:true,original_faces_preserved:true,result_is_independent_derivative:true,canonical_modified:false,shoulder_evidence_eligible:false,whole_tooth_watertight_claimed:false,
      note:'0=原 canonical；1=真实 POST 面恢复；2=估计补片。修补仅为用户勾选的独立衍生，未回写正式结果，也未输入肩台算法。'};
    const bytes = new TextEncoder().encode(JSON.stringify(record,null,2));
    const blob = zipStored([[suffix+'.ply',result.bytes],['repair_record.json',bytes],['hole_report.json',new Uint8Array(session.reportBytes)],['source_provenance.json',new Uint8Array(provenanceBytes)]]);
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${item.id.replace(/[^a-zA-Z0-9_-]/g,'_')}-${suffix}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url),30000);
    $('hole-status').textContent = '已生成所选修补版与来源记录下载；正式分割文件未修改。';
  } catch (error) { if (holeSession === session) $('hole-status').textContent = `下载未生成：${error.message}`; }
  finally { session.busy = false; if (holeSession === session) updateHoleControls(); }
}
function updateComparisons() {
  const report = current.platform_report;
  $('stage-status').replaceChildren(); $('final-comparison').replaceChildren();
  statusRow($('stage-status'),'geometry_modified','颈缘实体裁除',report?.geometry_modified,'removed');
  statusRow($('stage-status'),'labels_modified','颈缘标签调整',report?.labels_modified);
  statusRow($('stage-status'),'tessellation_modified','无损细分',report?.tessellation_modified,'tessellated');
  quantityRow($('stage-status'),'removed_area_mm2','实际删除面积',report?.removed_area_mm2);
  $('final-comparison-details').hidden = !current.final_comparison;
  $('final-comparison-title').textContent = `${versionName('before')} → ${versionName('after')} 正式产物比较`;
  if (!current.final_comparison) return;
  const complete = available(current.models?.before) && available(current.models?.after), comparison = complete ? current.final_comparison : {};
  const noMapping = comparison.labels_directly_comparable === false || comparison.topology_equal === false;
  statusRow($('final-comparison'),'final_mesh_representation_changed','网格表示 / 细分',comparison.mesh_representation_changed,'changed',complete ? '不可用（未提供）' : '不可用（最终产物不齐全）');
  statusRow($('final-comparison'),'final_labels_modified','最终标签',noMapping ? null : comparison.labels_modified,'modified',!complete ? '不可用（最终产物不齐全）' : noMapping ? '不可直接比较（网格表示或索引不同）' : '不可用（未提供）');
}
function updateAutoHoleControls() {
  const bundle = autoHoleReview(), section = $('auto-hole-controls');
  if (!section) { if (bundle) throw Error('自动补面查看器页面缺少控件'); return; }
  section.hidden = !bundle;
  for (const id of ['change-summary','platform-report-details','removed-note']) $(id).hidden = !!bundle;
  $('removed').closest('label').hidden = !!bundle;
  if (!bundle) { $('hole-details').hidden = false; return; }
  $('attempt-details').hidden = true; $('hole-details').hidden = true;
  const ranges = autoHoleRanges(), report = bundle.report || {}, count = ranges.reduce((sum,[start,end]) => sum + end - start,0);
  $('auto-hole-highlight').disabled = count === 0;
  if (!count) $('auto-hole-highlight').checked = false;
  $('auto-hole-focus').disabled = !count || !validBounds(bundle.patch_bounds);
  if (!['applied','unchanged'].includes(bundle.status) || report.synthetic_faces !== count || report.holes_repaired < 0) throw Error('自动补面状态与真实估计面数量不一致');
  $('auto-hole-status').textContent = bundle.status === 'applied'
    ? `自动补面已应用：${report.holes_repaired} 个内部孔，${count} 个估计面。原始分割保留在左侧及下载中，主颈部开放口保留。`
    : '自动检查完成，未新增补面；右侧完整模型沿用原始分割。孔洞检测及未采用原因可在记录中查看。';
  $('auto-hole-status').dataset.state = bundle.status;
  if ($('auto-hole-label-note')) $('auto-hole-label-note').textContent = autoHoleLabelNote() + '补面仍属估计来源，不作为真实扫描或肩台测量依据；橙色来源高亮只改变显示颜色。';
  $('auto-hole-report').textContent = JSON.stringify(report,null,2);
  $('auto-hole-downloads').replaceChildren();
  for (const [key,label] of [['report_json_url','自动补面记录 JSON'],['contract_json_url','默认显示 / 测量模型契约'],['provenance_npz_url','原面 / 估计面来源 NPZ']]) appendLink($('auto-hole-downloads'),bundle.downloads?.[key],label);
  const link = $('auto-hole-registration'); link.hidden = true; link.removeAttribute('href');
  if (current.registration_href) { const url = new URL(current.registration_href,location.href); if (['http:','https:'].includes(url.protocol)) { link.href = url.href; link.hidden = false; } }
}
function updateMetadata() {
  $('title').textContent = current.name || current.id;
  $('case-meta').textContent = `${current.prep_fdi} 牙位 · ${displayText(current.cohort_name || current.cohort) || '未标明来源组'} · 执行状态：${displayText(current.execution_status) || '清单未提供'}`;
  const duplicates = duplicatesOf(current);
  $('duplicates').hidden = !duplicates.length;
  $('duplicates').textContent = `相同输入扫描：${duplicates.join('、')}。各记录保留各自的处理结果，不计为独立扫描。`;
  const models = current.models || {};
  for (const option of $('display-mode').options) option.disabled = option.value === 'candidate' ? !available(models.candidate) : option.value === 'color' ? !available(models.input) && !available(models.refined) : !available(models.before) && !available(models.after);
  if (autoHoleReview()) {
    for (const option of $('display-mode').options) option.disabled = !['segmentation','grey','shoulder'].includes(option.value);
    if (!['segmentation','grey','shoulder'].includes($('display-mode').value)) $('display-mode').value = 'segmentation';
    $('removed').checked = false; $('reconstruction').checked = false;
  }
  // 缺产物的深链保留原模式与缺失说明，绝不切换到替代结果。
  updateRemovedControl(); updateComparisons(); updateAttemptRecord(); resetHoleReview();
  updateAutoHoleControls();
  $('notes').replaceChildren();
  const notes = Array.isArray(current.notes) ? current.notes : current.notes ? [current.notes] : [];
  if (current.execution_reason) { const li = document.createElement('li'); li.textContent = `执行说明：${displayText(current.execution_reason)}`; $('notes').append(li); }
  for (const note of notes) { const li = document.createElement('li'); li.textContent = displayText(note); $('notes').append(li); }
  $('platform-report').textContent = current.platform_report == null ? '本例未提供颈缘处理记录，采用与修改状态不可用。' : typeof current.platform_report === 'string' ? current.platform_report : JSON.stringify(current.platform_report,null,2);
  $('downloads').replaceChildren();
  const downloads = current.downloads || {};
  for (const [key,label,model] of [['before_ply_url',`${versionName('before')} 最终 PLY`,'before'],['before_labels_url',`${versionName('before')} 最终标签`,'before'],['after_ply_url',`${versionName('after')} 最终 PLY`,'after'],['after_labels_url',`${versionName('after')} 最终标签`,'after'],['input_ply_url','颈缘输入原色 PLY','input'],['refined_ply_url','颈缘输出原色 PLY','refined'],['removed_ply_url','颈缘实际删除片 PLY','removed'],['candidate_ply_url','颈缘试验候选 PLY','candidate'],['candidate_labels_url','颈缘试验候选标签 JSON','candidate']]) {
    if (available(models[model])) appendLink($('downloads'),downloads[key],label);
  }
  appendLink($('downloads'),downloads.platform_report_json_url,'颈缘处理记录 JSON');
  appendLink($('downloads'),downloads.platform_fields_npz_url,'颈缘输入诊断数组 NPZ');
  if (autoHoleReview()) appendLink($('downloads'),downloads.after_preview_ply_url,'自动补面分区颜色预览 PLY');
  for (const [key,label] of [['input','颈缘输入'],['refined','颈缘输出'],['removed','颈缘实际删除片'],['candidate','颈缘试验候选'],['after','最终产物']]) {
    if (available(models[key])) appendLink($('downloads'),downloads[key+'_source_provenance_npz_url'],label+'源面追溯 NPZ');
  }
  if (!$('downloads').children.length) $('downloads').textContent = '本例没有可下载的产物链接。';
}
function applyFilter() {
  let count = 0;
  for (const button of $('cases').querySelectorAll('[data-case]')) {
    button.hidden = filter !== 'all' && button.dataset.fdi !== filter;
    if (!button.hidden) count++;
    button.setAttribute('aria-pressed',String(button.dataset.case === current?.id));
  }
  for (const button of $('filters').querySelectorAll('[data-fdi]')) button.setAttribute('aria-pressed',String(button.dataset.fdi === filter));
  $('case-count').textContent = `${count} 条记录`;
}
function choose(id) {
  const selected = data.cases.find(item => item.id === id);
  if (!selected) { showError(`清单中没有样本 ${id}`); return; }
  if (current && current.id !== selected.id) {
    if ($('display-mode').value === 'candidate') $('display-mode').value = 'segmentation';
    $('removed').checked = false;
    if ($('auto-hole-highlight')) $('auto-hole-highlight').checked = false;
  }
  current = selected;
  if (filter !== 'all' && String(current.prep_fdi) !== filter) filter = 'all';
  updateMetadata(); applyFilter(); updateUrl(); render(true).catch(showError);
}
function countUnique() {
  const parents = new Map(data.cases.map(item => [item.id,item.id]));
  const find = id => { while (parents.get(id) !== id) id = parents.get(id); return id; };
  for (const item of data.cases) for (const duplicate of duplicatesOf(item)) if (parents.has(duplicate)) parents.set(find(duplicate),find(item.id));
  return new Set(data.cases.map(item => find(item.id))).size;
}
function firstCount(object,keys,fallback) {
  for (const key of keys) if (Number.isInteger(object?.[key]) && object[key] >= 0) return object[key];
  return fallback;
}
function hashId() { try { return decodeURIComponent(location.hash.slice(1)); } catch { return location.hash.slice(1); } }
async function start() {
  const response = await fetch('./neck_refinement_manifest.json',{cache:'no-store'});
  if (!response.ok) throw Error(`无法读取颈缘对照清单（HTTP ${response.status}）`);
  data = await response.json();
  $('comparison-subtitle').textContent = `最终结果 ${versionName('before')} → ${versionName('after')} · 颈缘原色与试验候选另有独立模式`;
  if (data.review_kind === 'automatic_hole_repair') {
    if (!Array.isArray(data.cases) || data.cases.some(item => !autoHoleReview(item))) throw Error('自动补面清单缺少逐例完整结果');
    $('comparison-subtitle').textContent = '原始分割 → 自动补面后的完整模型 · 保留四色肩台与补前对照';
    if (data.source_review_href) {
      const url = new URL(data.source_review_href,location.href);
      if (['http:','https:'].includes(url.protocol)) {
        const link = document.createElement('a'); link.id = 'auto-hole-original-review'; link.href = url.href;
        link.textContent = '返回原始整批结果'; link.style.marginLeft = '14px'; header.append(link);
      }
    }
  }
  if (typeof data.review_title === 'string' && data.review_title.trim()) {
    document.title = data.review_title.trim(); $('review-title').textContent = document.title;
  }
  if (data.review_note) { $('review-note').textContent = displayText(data.review_note); $('review-note').hidden = false; }
  if (data.visual_review_html_url) {
    const url = new URL(data.visual_review_html_url,location.href);
    if (['http:','https:'].includes(url.protocol)) { $('visual-review-link').href = url.href; $('visual-review-link').hidden = false; }
  }
  if (data.methodology_url) { const url = new URL(data.methodology_url,location.href); if (['http:','https:'].includes(url.protocol)) { $('methodology-link').href = url.href; $('methodology-link').hidden = false; } }
  if (!Array.isArray(data.cases) || !data.cases.length) throw Error('颈缘对照清单没有可展示的记录');
  if (new Set(data.cases.map(item => item.id)).size !== data.cases.length || data.cases.some(item => typeof item.id !== 'string' || !item.id)) throw Error('颈缘对照清单含重复或无效记录编号');
  const records = firstCount(data.summary,['records','record_count','total_records'],data.cases.length);
  const unique = firstCount(data.summary,['unique_post_inputs','unique_scans','unique_scan_count'],countUnique());
  const incisors = data.cases.filter(item => Number(item.prep_fdi) === 11).length, molars = data.cases.filter(item => Number(item.prep_fdi) === 46).length;
  const uniqueText = data.review_kind === 'automatic_hole_repair' && data.summary?.unique_post_inputs == null ? '独立输入扫描数尚未核实' : `${unique} 个独立输入扫描`;
  $('summary').textContent = `${records} 条记录 · ${uniqueText} · 11 切牙 ${incisors} 条 / 46 磨牙 ${molars} 条。相同扫描的不同运行保留为独立对照记录。`;
  if (typeof data.report_url === 'string' && data.report_url) {
    const url = new URL(data.report_url,location.href);
    if (['http:','https:'].includes(url.protocol)) { $('report-link').href = url.href; $('report-link').hidden = false; }
  }
  for (const item of data.cases) {
    const button = document.createElement('button'), name = document.createElement('span'), state = document.createElement('small');
    button.className = 'case'; button.dataset.case = item.id; button.dataset.fdi = String(item.prep_fdi);
    name.textContent = item.name || item.id;
    const complete = available(item.models?.before) && available(item.models?.after);
    state.textContent = `${item.prep_fdi} · ${complete ? `${versionName('before')} / ${versionName('after')} 最终可对照` : '最终产物不齐全'}${duplicatesOf(item).length ? ' · 重复输入' : ''}`;
    if (!complete) state.className = 'unavailable';
    button.append(name,state);
    button.onclick = event => {
      choose(item.id);
      // 仅窄屏下的实际点击/键盘选择移动页面；初始化与 hash 导航保留滚动位置。
      if (event.isTrusted && matchMedia('(max-width:1000px)').matches) {
        $('title').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
      }
    };
    $('cases').append(button);
  }
  const excluded = Array.isArray(data.excluded) ? data.excluded : [];
  $('excluded-details').hidden = !excluded.length; $('excluded-count').textContent = `（${excluded.length}）`;
  for (const item of excluded) {
    const li = document.createElement('li');
    li.textContent = typeof item === 'string' ? item : `${item.name || item.id || '未命名记录'}：${displayText(item.reason || item.notes || item.execution_status) || '未生成本轮可对照产物'}`;
    $('excluded').append(li);
  }
  for (const button of $('filters').querySelectorAll('[data-fdi]')) button.onclick = () => {
    filter = button.dataset.fdi; applyFilter();
    if (filter !== 'all' && String(current.prep_fdi) !== filter) {
      const first = data.cases.find(item => String(item.prep_fdi) === filter);
      if (first) choose(first.id);
    }
    updateUrl();
  };
  for (const button of $('views').querySelectorAll('[data-view]')) button.onclick = () => { view = button.dataset.view; fit(); updateUrl(); };
  $('fit').onclick = fit;
  if ($('auto-hole-highlight')) $('auto-hole-highlight').onchange = () => render(false).catch(showError);
  if ($('auto-hole-focus')) $('auto-hole-focus').onclick = () => { const bundle = autoHoleReview(); if (bundle && validBounds(bundle.patch_bounds)) fit(bundle.patch_bounds); };
  $('hole-undo').onclick = () => { if (!holeSession?.undo.length) return; holeSession.selected = new Set(holeSession.undo.pop()); updateHoleControls(); render(false).catch(showError); };
  $('hole-clear').onclick = () => { if (!holeSession?.selected.size) return; holeSession.undo.push([...holeSession.selected]); holeSession.selected.clear(); updateHoleControls(); render(false).catch(showError); };
  $('hole-download').onclick = downloadSelectedRepair;
  $('reconstruction').onchange = () => { if (!reconstructionSession?.ready) $('reconstruction').checked = false; render(false).catch(showError); };
  for (const id of ['display-mode','removed','wire']) $(id).onchange = () => { if ($('display-mode').value !== 'repair') $('reconstruction').checked = false; updateUrl(); render(false).catch(showError); };
  window.addEventListener('hashchange',() => choose(hashId()));
  const initial = hashId() || data.cases.find(item => filter === 'all' || String(item.prep_fdi) === filter)?.id || data.cases[0].id;
  choose(initial);
}
start().catch(error => { $('status').textContent = '清单不可用'; showError(error); });
