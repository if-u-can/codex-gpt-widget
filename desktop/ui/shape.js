(() => {
  'use strict';
  const bridge=window.whaleDesktop;
  if(bridge?.platform!=='win32'||typeof bridge.shape!=='function')return;
  let scheduled=0,last='',updates=0,rectangles=[];
  let workArea=bridge.workArea;
  let dragDrawing=false,endingDrag=false;
  const margin=16;
  const animationPromises=new WeakMap();
  function visible(el,opening=false){
    if(!el?.isConnected||el.hidden)return false;
    return el.checkVisibility({visibilityProperty:true,opacityProperty:!opening});
  }
  function clipBounds(r){
    if(r.width<=0||r.height<=0)return null;
    const valid=workArea&&['left','top','right','bottom'].every(k=>Number.isFinite(workArea[k]));
    // Shadows belong to the desktop work area too. Round its edges inward so
    // native DIP-to-pixel rounding cannot paint over the taskbar by one pixel.
    const left=valid?Math.max(0,Math.ceil(workArea.left)):0,top=valid?Math.max(0,Math.ceil(workArea.top)):0;
    const maxRight=valid?Math.min(innerWidth,Math.floor(workArea.right)):innerWidth,maxBottom=valid?Math.min(innerHeight,Math.floor(workArea.bottom)):innerHeight;
    const x=Math.max(left,Math.floor(r.left-margin)),y=Math.max(top,Math.floor(r.top-margin));
    const right=Math.min(maxRight,Math.ceil(r.right+margin)),bottom=Math.min(maxBottom,Math.ceil(r.bottom+margin));
    return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
  }
  function bounds(el){return clipBounds(el.getBoundingClientRect());}
  function paintingAnimations(el){
    // A removed open class starts the CSS exit; it does not end native drawing.
    // Descendant transitions include the bubble's staggered tail and text fades.
    const active=[];
    for(const animation of el.getAnimations({subtree:true})){
      if(animation.playState==='finished'||animation.playState==='idle')continue;
      const endTime=animation.effect?.getComputedTiming().endTime;
      // A decorative infinite loop must not keep a closed surface or RAF alive.
      if(!Number.isFinite(endTime)||endTime<=0)continue;
      const finished=animation.finished;
      if(animationPromises.get(animation)!==finished){
        animationPromises.set(animation,finished);
        // Re-evaluate current DOM state, never remove a surface from an old
        // completion callback: an interrupted exit may already have reopened.
        finished.then(request,request);
      }
      active.push(animation);
    }
    return active;
  }
  function publish(force=false){
    if(scheduled){cancelAnimationFrame(scheduled);scheduled=0;}
    if(dragDrawing){
      if(document.querySelector('.dshwv-root.dshwv-dragging'))return;
      // The application's release/cancel/blur handlers have already committed
      // their final position. Restore precise islands before another input.
      dragDrawing=false;endingDrag=true;force=true;
    }
    const result=[],seen=new Set();let animate=false;
    const addRect=r=>{if(!r)return;const key=JSON.stringify(r);if(!seen.has(key)){seen.add(key);result.push(r);}};
    const add=(el,opening=false)=>{if(visible(el,opening))addRect(bounds(el));};
    const running=animations=>animations.some(a=>a.pending||(a.playState==='running'&&a.playbackRate!==0));
    // Drawing lifetime is separate from input.js's open/visible hit surfaces.
    // Keep only these bounded UI islands, never a viewport-sized input backdrop.
    document.querySelectorAll('.dshwv-img').forEach(e=>add(e,true));
    for(const root of document.querySelectorAll('.dshwv-root')){
      if(!visible(root,true))continue;
      const position=root.closest('.dshwv-position');
      const animations=paintingAnimations(position||root).filter(a=>!a.effect?.target||a.effect.target.matches('.dshwv-position,.dshwv-root,.dshwv-body,.dshwv-img'));
      if(running(animations))animate=true;
      if(!animations.length&&!root.classList.contains('dshwv-dragging'))continue;
      // During a flip, the transformed image briefly becomes almost zero-width.
      // Reserve the local sprite/bubble canvas throughout finite motion, rather
      // than clipping a later compositor frame to that transient narrow slice.
      const origin=(position||root).getBoundingClientRect(),w=root.offsetWidth,h=root.offsetHeight;
      if(w>0&&h>0){
        addRect(clipBounds({left:origin.left,top:origin.top,right:origin.left+w,bottom:origin.top+h,width:w,height:h}));
        // A CSS positional transition paints toward its new inline destination.
        // Include that endpoint before the next frame crosses the native IPC.
        if(position?.style.transform&&typeof DOMMatrixReadOnly==='function'){
          try{const end=new DOMMatrixReadOnly(position.style.transform);addRect(clipBounds({left:end.m41,top:end.m42,right:end.m41+w,bottom:end.m42+h,width:w,height:h}));}catch{}
        }
      }
    }
    for(const el of document.querySelectorAll('.dshwv-pop,.dshwv-menu-btn,.dshwv-menu')){
      if(!visible(el,true))continue;
      const animations=paintingAnimations(el);
      if(el.matches('.dshwv-pop-open,.dshwv-menu-btn-visible,.dshwv-menu-open')||animations.length)add(el,true);
      // Follow moving bounds for the actual finite animation lifetime. Paused
      // animations preserve their pixels without starting an endless RAF loop.
      if(running(animations))animate=true;
    }
    document.querySelectorAll('dialog[open],.whale-account-card,.dshwv-rolelist,.dshwv-audiolist,.dshwv-qedit,.dshwv-usagepanel,.dshwv-custmenu,.dshwv-tplhelp,.dshwv-fx-info,#toast:not([hidden])').forEach(e=>add(e));
    // Modal backdrops are viewport-sized. Include their cards, not the backdrop.
    function card(el,depth=0){if(!visible(el))return;const r=el.getBoundingClientRect();if(depth<3&&r.width>=innerWidth*.95&&r.height>=innerHeight*.95){for(const child of el.children)card(child,depth+1);}else add(el);}
    document.querySelectorAll('[class*="mask"]').forEach(e=>{if(!e.closest('.dshwv-root'))card(e);});
    rectangles=result.slice(0,64);
    const key=JSON.stringify(rectangles);
    if(force||key!==last){last=key;updates++;if(endingDrag){if(bridge.dragDrawing(false,rectangles))endingDrag=false;else{last='';request();}}else bridge.shape(rectangles);}
    if(animate)request();
  }
  function request(){if(!scheduled)scheduled=requestAnimationFrame(()=>{scheduled=0;publish();});}
  // Flex layout, font loading and intrinsic content can resize a surface without
  // changing its own attributes or the document viewport. Track the surfaces too.
  const observed=new Set(),resizeObserver=new ResizeObserver(request);
  function trackSurfaces(){
    const targets=new Set(document.querySelectorAll('.dshwv-img,.dshwv-root,.dshwv-pop,.dshwv-menu-btn,.dshwv-menu,dialog,.whale-account-card,[class*="mask"]>*'));
    targets.add(document.documentElement);
    for(const el of observed)if(!targets.has(el)){resizeObserver.unobserve(el);observed.delete(el);}
    for(const el of targets)if(!observed.has(el)){observed.add(el);resizeObserver.observe(el);}
  }
  // Attribute changes are delivered before paint. Posting the new region here
  // avoids keeping the previous drag position until one more animation frame.
  new MutationObserver(()=>{trackSurfaces();publish();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','hidden','open','src']});
  trackSurfaces();
  document.fonts?.ready.then(request);
  document.addEventListener('load',request,true);
  window.addEventListener('resize',request);
  bridge.onWorkArea?.(area=>{workArea=area;last='';publish(true);});
  if(typeof bridge.dragDrawing==='function')window.WhaleDragDrawing=Object.freeze({begin:()=>{
    if(!bridge.dragDrawing(true))return false;
    dragDrawing=true;last='';updates++;
    rectangles=[clipBounds({left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight})].filter(Boolean);
    return true;
  }});
  window.addEventListener('whale-shape-request',()=>{last='';publish(true);});
  for(const name of ['transitionrun','transitionend','transitioncancel','animationstart','animationend','animationcancel'])document.addEventListener(name,request,true);
  window.WhaleRendering?.onFrame(()=>publish());
  if(bridge.testMode)window.__whaleShapeTest={publish:()=>publish(true),status:()=>({updates,rectangles,dragDrawing})};
  publish(true);
})();
