import * as THREE from 'three';

// 一个页面只保留一个 WebGL context。两个交互画布显示各自刚渲染的帧；
// 场景、相机、拾取和剖切仍为真实三维，不改变模型或标签。
const views=new Set();
let shared=null,frame=0,retryTimer=0,blocked=false,automaticRetries=0,pageHidden=false;
let removeContextListener=null;
const active=()=>!document.hidden&&!pageHidden;

function notice(message){
 for(const view of views){
  if(!view.message){
   const box=document.createElement('div');box.className='render-notice';box.setAttribute('role','status');
   box.style.cssText='position:absolute;inset:auto 12px 12px;padding:12px;background:#172330f2;border:1px solid #899fb4;border-radius:6px;z-index:5';
   const text=document.createElement('span'),button=document.createElement('button');
   button.type='button';button.textContent='重试三维显示';button.style.marginLeft='10px';
   button.onclick=()=>{automaticRetries=0;retry();};
   box.append(text,button);view.message={box,text};
  }
  if(!view.message.box.isConnected)view.domElement.parentElement?.append(view.message.box);
  view.message.text.textContent=message;view.message.box.hidden=!message;
  // 失败时不能把上一病例的旧帧留在新病例标题下。
  view.domElement.style.visibility=message?'hidden':'visible';
  if(message)view.domElement.dataset.renderState='unavailable';
 }
}

function release(){
 cancelAnimationFrame(frame);frame=0;clearTimeout(retryTimer);retryTimer=0;
 const old=shared;shared=null;
 removeContextListener?.();removeContextListener=null;
 if(old){old.dispose();old.forceContextLoss();old.domElement.width=1;old.domElement.height=1;}
}

function failed(){
 blocked=true;
 notice('三维显示资源暂时不可用。可关闭不再使用的旧查看页后重试。');
 // 有限重试，避免驱动或浏览器始终拒绝时不断申请上下文。
 if(active()&&automaticRetries<2){automaticRetries++;retryTimer=setTimeout(retry,750*automaticRetries);}
}

function createContext(){
 if(shared||blocked||!active())return shared;
 for(const antialias of [true,false]){
  const canvas=document.createElement('canvas');let gl=null;
  try{
   const options={antialias,alpha:false,depth:true,stencil:false,preserveDrawingBuffer:false,powerPreference:'default'};
   for(const type of ['webgl2','webgl']){gl=canvas.getContext(type,options);if(gl)break;}
   if(!gl)continue;
   shared=new THREE.WebGLRenderer({...options,canvas,context:gl});
   const lost=event=>{event.preventDefault();release();failed();};
   canvas.addEventListener('webglcontextlost',lost);
   removeContextListener=()=>canvas.removeEventListener('webglcontextlost',lost);
   notice('');return shared;
  }catch(error){
   shared?.dispose();shared=null;gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
 }
 failed();return null;
}

function requestDraw(){if(!frame&&active()&&!blocked)frame=requestAnimationFrame(flush);}
function retry(){clearTimeout(retryTimer);retryTimer=0;blocked=false;requestDraw();}

function flush(){
 frame=0;if(!active())return;
 const ready=[...views].filter(v=>v.scene&&v.width>0&&v.height>0);
 if(!ready.length)return;
 const renderer=createContext();if(!renderer)return;
 try{
  for(const view of ready){
   // 限制显示缓冲区的像素开销，不简化牙齿网格。
   const ratio=Math.min(view.ratio,Math.sqrt(2_000_000/(view.width*view.height)));
   renderer.setPixelRatio(ratio);renderer.setSize(view.width,view.height,false);
   renderer.outputColorSpace=view.outputColorSpace;renderer.localClippingEnabled=view.localClippingEnabled;
   renderer.render(view.scene,view.camera);
   if(renderer.getContext().isContextLost())return;
   const source=renderer.domElement,target=view.domElement;
   if(target.width!==source.width)target.width=source.width;
   if(target.height!==source.height)target.height=source.height;
   // 同一个任务内复制，避免依赖 preserveDrawingBuffer 或额外 WebGL context。
   view.context.drawImage(source,0,0);target.dataset.renderState='ready';
  }
 }catch(error){release();failed();}
}

export class PanelRenderer{
 constructor(){
  this.domElement=document.createElement('canvas');this.context=this.domElement.getContext('2d',{alpha:false});
  this.width=0;this.height=0;this.ratio=1;this.scene=null;this.camera=null;
  this.outputColorSpace=THREE.SRGBColorSpace;this.localClippingEnabled=false;views.add(this);
 }
 setPixelRatio(ratio){this.ratio=Math.min(Math.max(1,ratio||1),2);requestDraw();}
 setSize(width,height){this.width=Math.max(0,Math.floor(width));this.height=Math.max(0,Math.floor(height));requestDraw();}
 render(scene,camera){this.scene=scene;this.camera=camera;requestDraw();}
 dispose(){views.delete(this);this.message?.box.remove();this.scene=null;this.camera=null;if(!views.size)release();}
}

// 只缓存有限个已访问模型，防止逐例审阅时把整批扫描常驻内存。
export class ModelCache extends Map{
 constructor(limit=8){super();this.limit=limit;}
 get(key){const value=super.get(key);if(super.has(key)){super.delete(key);super.set(key,value);}return value;}
 set(key,value){
  super.delete(key);super.set(key,value);
  while(this.size>this.limit)super.delete(this.keys().next().value);
  if(value?.then)value.catch(()=>{if(super.get(key)===value)super.delete(key);});
  return this;
 }
}

document.addEventListener('visibilitychange',()=>{
 if(!active())release();else{automaticRetries=0;retry();}
});
window.addEventListener('pagehide',()=>{pageHidden=true;release();});
window.addEventListener('pageshow',()=>{pageHidden=false;automaticRetries=0;retry();});
