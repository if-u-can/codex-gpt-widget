import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { BrowserWindow } = createRequire(import.meta.url)('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifySurfaceLifecycle({ app, window, screen, setHost, setTestCursor, dataDir, renderInfo }) {
  const output = path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR);
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, checks: [], samples: [], menuPaths: [], dataDir };
  const dragOnly = process.env.WHALE_SURFACE_DRAG_ONLY === '1';
  report.nativeRegionOnly = dragOnly;
  const ev = code => window.webContents.executeJavaScript(code);
  const wait = async (code, message) => {
    const end = Date.now() + 7000;
    while (Date.now() < end) { if (await ev(code)) return; await delay(35); }
    throw Error('Timed out: ' + message);
  };
  let backdrop, helper;
  try {
    assert.equal(process.platform, 'win32', 'native region regression requires Windows');
    assert.ok(process.env.WHALE_TEST_PYTHON, 'set WHALE_TEST_PYTHON to Python with Pillow');
    const area = screen.getPrimaryDisplay().workArea;
    const dip = { x: area.x + 30, y: area.y + 30, width: 700, height: 550 };
    await setHost({ hostAlive: true, hostPid: 123456, window: '0', visible: true, attached: true, bounds: screen.dipToScreenRect(null, dip) });
    await wait("document.querySelector('.dshwv-img')?.naturalWidth > 0 && window.__whaleRenderTest?.status().balance === 12.3456 && !__whaleRenderTest.status().busy", 'fixture ready');
    await delay(1800);
    await ev("__whaleRenderTest.scale(1); __whaleRenderTest.place(140,140,false); __whaleRenderTest.close()");
    await delay(700);
    // Isolate animation clipping from other applications and never capture user
    // content. Topmost is confined to this temporary test backdrop: this test
    // makes no claim about production stacking or intermittent visibility.
    backdrop = new BrowserWindow({ ...window.getBounds(), frame: false, thickFrame: false, resizable: false, roundedCorners: false, hasShadow: false, show: false, backgroundColor: '#253953', webPreferences: { sandbox: true } });
    await backdrop.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#253953"></body>'));
    if (!dragOnly) backdrop.setAlwaysOnTop(true);
    window.setParentWindow(backdrop); backdrop.showInactive(); if (!dragOnly) window.setAlwaysOnTop(true); window.showInactive(); if (!dragOnly) window.moveTop();
    await delay(250);
    report.windows = { widget: window.getBounds(), backdrop: backdrop.getBounds(), backdropVisible: backdrop.isVisible(), background: await backdrop.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor') };
    let seq = 0;
    const pending = new Map();
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    helper = spawn(process.env.WHALE_TEST_PYTHON, ['-u', fileURLToPath(new URL('./surface-native-probe.py', import.meta.url)), window.getNativeWindowHandle().readBigUInt64LE().toString(), String(process.pid), backdrop.getNativeWindowHandle().readBigUInt64LE().toString(), output], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let helperErrors = ''; helper.stderr.on('data', b => { helperErrors += b; });
    createInterface({ input: helper.stdout }).on('line', line => {
      const result = JSON.parse(line);
      if (result.ready) readyResolve();
      else { const finish = pending.get(result.id); pending.delete(result.id); finish?.(result); }
    });
    await Promise.race([ready, delay(6000).then(() => { throw Error('Native probe did not start: ' + helperErrors); })]);
    const probe = async request => {
      const id = ++seq;
      const response = new Promise(resolve => pending.set(id, resolve));
      helper.stdin.write(JSON.stringify({ id, ...request }) + '\n');
      const result = await Promise.race([response, delay(4000).then(() => { throw Error('Native probe timeout'); })]);
      if (!(result.kind > 0)) report.samples.push({cycle:'unknown-native-region',request,native:result,rendererShape:await ev('__whaleShapeTest.status()')});
      assert.equal(result.error, undefined); assert.ok(result.kind > 0, 'actual Windows HRGN must exist: ' + JSON.stringify(result));
      return result;
    };
    const scale = await ev('devicePixelRatio');
    const visual = () => ev("(()=>{const p=document.querySelector('.dshwv-pop'); return {open:p.classList.contains('dshwv-pop-open'), painted:[...p.querySelectorAll('.dshwv-bshape,.dshwv-b1,.dshwv-b2')].some(e=>Number(getComputedStyle(e).opacity)>.01), animations:p.getAnimations({subtree:true}).filter(a=>a.playState==='running'||a.playState==='pending').length, shape:__whaleShapeTest.status()};})()");
    const show = async () => { await ev("__whaleRenderTest.showCost(.003,{completionKind:'success',amount:.003,currency:'USD',costState:'observed',tokens:40,label:'Fixture usage:'})"); await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching", 'bubble opens'); await delay(650); };
    const capture = async (name, request = {}) => {
      if (dragOnly) return probe(request);
      // Transparent test clicks can bring an unrelated app above the temporary
      // backdrop. Bring only our isolated fixture forward before pixel capture.
      backdrop.moveTop();window.moveTop();
      const result = await probe({ ...request, capture: name + '.png' });
      assert.equal(result.unobscured, true, 'screen evidence inconclusive: ' + JSON.stringify(result.occlusion));
      assert.ok(result.nonBackdropPixels > 40, 'native screen capture must contain rendered widget pixels');
      assert.ok(result.capture, 'capture did not contain the isolated opaque backdrop: ' + JSON.stringify({background:result.backdropPixels,total:result.pixelCount}));
      return result;
    };
    const petPoint=()=>ev(`(()=>{
      const img=document.querySelector('.dshwv-img'),r=img.getBoundingClientRect(),flip=WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0;
      let point=null,distance=Infinity;
      for(let y=Math.ceil(r.top)+2;y<r.bottom-2;y+=3)for(let x=Math.ceil(r.left)+2;x<r.right-2;x+=3){
        const target=document.elementFromPoint(x,y);
        if(target?.closest('.dshwv-menu,.dshwv-menu-btn,.dshwv-pop-open')||!WhaleRendering.hitCache.hit(img,x,y,flip))continue;
        const d=(x-r.left-r.width/2)**2+(y-r.top-r.height/2)**2;
        if(d<distance){distance=d;point={x,y};}
      }
      return point;
    })()`);
    if (!dragOnly) {
    for (const reopen of [false, true]) {
      await show();
      const bubble=await ev("document.querySelector('.dshwv-pop').getBoundingClientRect().toJSON()");
      const points=[[bubble.left+2,bubble.top+2],[bubble.right-2,bubble.top+2],[bubble.left+2,bubble.bottom-2],[bubble.right-2,bubble.bottom-2],[(bubble.left+bubble.right)/2,(bubble.top+bubble.bottom)/2]].map(p=>p.map(v=>Math.round(v*scale)));
      const before = await capture(reopen ? 'rapid-before' : 'close-before', { points });
      assert.ok(before.contains.every(Boolean), 'opened bubble is fully present in real Windows region');
      await ev('__whaleRenderTest.close()');
      const started = Date.now();
      for (const target of [0,60,130,220,340,460,600,780]) {
        await delay(Math.max(0, started + target - Date.now()));
        if (reopen && target === 130) await ev("__whaleRenderTest.showCost(.004,{completionKind:'success',amount:.004,currency:'USD',costState:'observed',tokens:50,label:'Reopened fixture:'})");
        const state = await visual();
        const native = target === 220 || target === 460 ? await capture(`${reopen?'rapid':'close'}-${target}`, { points }) : await probe({ points });
        const afterRead = await visual();
        report.samples.push({ cycle: reopen ? 'rapid-reopen' : 'close', target, elapsed: Date.now()-started, state, afterRead, native });
        // A pixel capture can cross the end of the exit animation. Require the
        // bubble to be painting on both sides of this asynchronous native read.
        if ((state.open || state.painted || state.animations) && (afterRead.open || afterRead.painted || afterRead.animations)) assert.ok(native.contains.every(Boolean), `native bubble clipped while visible at ${target}ms (${reopen?'reopen':'close'})`);
        if (!reopen && target === 780) assert.equal(native.contains[0], false, 'finished close releases the bubble-only upper corner');
      }
      if (reopen) assert.equal((await visual()).open, true, 'old close callbacks cannot dismiss a reopened bubble');
      await ev('__whaleRenderTest.close()'); await delay(800);
    }
    report.checks.push('actual GetWindowRgn/GetRegionData retains complete bubble through closing frames and drops it after completion; rapid reopening survives old close callbacks');
    // The native region must follow movement independently of any fixed input
    // refresh timer. Stretch this real ancestor transform past 600 ms so that
    // a missing animation observer fails deterministically, rather than relying
    // on one lucky renderer-to-main IPC race at normal animation speed.
    await ev(`(() => {
      const p=document.querySelector('.dshwv-position');
      window.__clippingMotion=p.animate([{transform:'translate3d(140px,140px,0)'},{transform:'translate3d(410px,210px,0)'}],{duration:1400,fill:'forwards',easing:'linear'});
      __whaleShapeTest.publish();
    })()`);
    for(const pause of [750,350]) {
      await delay(pause);
      const geometry=await ev("document.querySelector('.dshwv-img').getBoundingClientRect().toJSON()");
      const points=[[geometry.left+2,geometry.top+2],[geometry.right-2,geometry.bottom-2]].map(p=>p.map(v=>Math.round(v*scale)));
      const native=await probe({points});
      report.samples.push({cycle:'ancestor-motion',geometry,native});
      assert.ok(native.contains.every(Boolean),'moving sprite is clipped after the fixed input presentation timer');
    }
    await ev("__clippingMotion.cancel(); __whaleRenderTest.place(140,140,false)");await delay(450);
    report.checks.push('actual native region follows a sprite ancestor transform after the old 600 ms timer expires');
    const samplePet=async name=>{
      const geometry=await ev("document.querySelector('.dshwv-img').getBoundingClientRect().toJSON()");
      const points=[[geometry.left+2,geometry.top+2],[geometry.right-2,geometry.bottom-2]].map(p=>p.map(v=>Math.round(v*scale)));
      const native=await probe({points});
      report.samples.push({cycle:name,geometry,native});
      assert.ok(native.contains.every(Boolean),'actual mouse gesture clips the sprite: '+name);
    };
    window.focus();await wait('document.hasFocus()','gesture fixture focus');
    let dragPoint=await petPoint();assert.ok(dragPoint);
    setTestCursor(dragPoint);window.webContents.sendInputEvent({type:'mouseMove',...dragPoint});await delay(100);
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...dragPoint});await delay(20);
    for(const offset of [{x:170,y:65},{x:40,y:140},{x:290,y:-65},{x:110,y:20}]){
      const point={x:dragPoint.x+offset.x,y:dragPoint.y+offset.y};setTestCursor(point);
      window.webContents.sendInputEvent({type:'mouseMove',...point});await delay(30);
      await samplePet('actual-drag');
    }
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:dragPoint.x+110,y:dragPoint.y+20});
    for(const pause of [20,80,170]){await delay(pause);await samplePet('actual-drop');}
    await ev('__whaleRenderTest.close()');await delay(700);
    for(let i=0;i<8;i++){
      const point=await petPoint();assert.ok(point,'rapid press has a real exposed sprite pixel');setTestCursor(point);
      window.webContents.sendInputEvent({type:'mouseMove',...point});
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});await delay(12);
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(12);
      await samplePet('rapid-click');
    }
    await delay(650);await samplePet('rapid-click-settled');
    await ev('__whaleRenderTest.close();__whaleRenderTest.place(140,140,false)');await delay(800);
    report.checks.push('real Electron pointer drag, drop and eight rapid clicks keep every sprite corner in the actual Windows region');
    const getMenuGeometry = () => ev(`(()=>{
      const img=document.querySelector('.dshwv-img'), b=document.querySelector('.dshwv-menu-btn').getBoundingClientRect(), r=img.getBoundingClientRect();
      const flipped=WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0;
      const button={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}, solid=[],empty=[];
      for(let y=Math.max(1,Math.ceil(r.top));y<Math.min(innerHeight-1,r.bottom);y+=2)for(let x=Math.max(1,Math.ceil(r.left));x<Math.min(innerWidth-1,r.right);x+=2){
        if(x>=b.left-2&&x<=b.right+2&&y>=b.top-2&&y<=b.bottom+2)continue;
        const p={x,y};
        if(WhaleRendering.hitCache.hit(img,x,y,flipped))solid.push(p);
        else if(!__whaleInputTest.hit(p))empty.push(p);
      }
      const distance=(p,q)=>(p.x-q.x)**2+(p.y-q.y)**2;
      empty.sort((p,q)=>distance(p,button)-distance(q,button));
      const gap=empty[0];
      solid.sort((p,q)=>distance(p,gap)-distance(q,gap));
      return {pet:solid[0],gap,button};
    })()`);
    const move = async (point, pause) => {
      setTestCursor(point); await delay(25);
      // Production does not forward mouse movement while the overlay ignores
      // input. Only send Chromium movement once native interaction is enabled.
      if (renderInfo().inputEnabled) window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      await delay(pause);
    };
    const click = async p => {
      assert.equal(renderInfo().inputEnabled, true, 'real button route must enable native input');
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p}); await delay(25);
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p}); await delay(180);
    };
    for (const speed of ['slow','fast']) {
      await move({x:5,y:500},400);
      const menuGeometry=await getMenuGeometry(); assert.ok(menuGeometry.pet&&menuGeometry.gap);
      await move(menuGeometry.pet,250);
      const steps = speed==='slow'?18:5, pause = speed==='slow'?75:0;
      const samples=[], menuEntry={speed,geometry:menuGeometry,samples}; report.menuPaths.push(menuEntry);
      for(let i=0;i<=steps;i++) {
        const middle=Math.floor(steps/2), first=i<=middle;
        const from=first?menuGeometry.pet:menuGeometry.gap,to=first?menuGeometry.gap:menuGeometry.button,t=first?i/middle:(i-middle)/(steps-middle);
        const p={x:Math.round(from.x+(to.x-from.x)*t),y:Math.round(from.y+(to.y-from.y)*t)};
        await move(p,pause);
        const state=await ev(`(()=>{const b=document.querySelector('.dshwv-menu-btn');return {visible:b.classList.contains('dshwv-menu-btn-visible'),opacity:Number(getComputedStyle(b).opacity),hit:__whaleInputTest.hit(${JSON.stringify(p)})};})()`);
        // Renderer-to-main input flags travel asynchronously over IPC. Wait a
        // bounded interval for that update before testing Windows hit routing.
        const inputAt=Date.now();
        while(renderInfo().inputEnabled!==state.hit && Date.now()-inputAt<250)await delay(5);
        const sample={point:p,...state,inputEnabled:renderInfo().inputEnabled,inputSettleMs:Date.now()-inputAt}; samples.push(sample);
        assert.ok(state.visible && state.opacity>.8, 'menu button must remain visible across transparent hover gap: '+JSON.stringify({speed,i,state,p}));
        if(!state.hit){
          assert.equal(renderInfo().inputEnabled,false,'transparent hover corridor remains click-through');
          const native=await probe({hitPoints:[[Math.round(p.x*scale),Math.round(p.y*scale)]]});
          assert.equal(native.hitsWidget[0],false,'Windows routes the transparent gap to the underlying window');
          sample.nativeHitWidget=native.hitsWidget[0];
        }
      }
      assert.ok(samples.some(s=>!s.hit),'path must actually cross a transparent gap');
      await click(menuGeometry.button);
      assert.equal(await ev("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')"),true,'menu accepts click after crossing gap');
      await capture('menu-'+speed);
      // The existing dashboard may overlap its toggle button. Close through
      // the exposed sprite, the widget's established in-widget close gesture.
      const closePoint=await ev(`(()=>{const img=document.querySelector('.dshwv-img'),r=img.getBoundingClientRect(),flip=WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0;for(let y=Math.ceil(r.top);y<r.bottom;y+=2)for(let x=Math.ceil(r.left);x<r.right;x+=2){const e=document.elementFromPoint(x,y);if(!e?.closest('.dshwv-menu,.dshwv-menu-btn,.dshwv-pop-open')&&WhaleRendering.hitCache.hit(img,x,y,flip))return {x,y};}return null;})()`);
      assert.ok(closePoint,'an exposed sprite pixel must remain available');
      await move(closePoint,80); await click(closePoint);
      assert.equal(await ev("document.querySelector('.dshwv-menu').classList.contains('dshwv-menu-open')"),false,'sprite click closes the expanded menu');
      await move({x:5,y:500},550);
      const hiddenInput=await ev(`(()=>{const p=${JSON.stringify(menuGeometry.button)};return {hit:__whaleInputTest.hit(p),pet:WhaleRendering.hitCache.hit(document.querySelector('.dshwv-img'),p.x,p.y,WhaleRendering.mirrorScale(document.querySelector('.dshwv-root'))<0)};})()`);
      assert.equal(hiddenInput.hit,hiddenInput.pet,'hidden button adds no hotspot beyond the sprite pixels underneath it');
      const hidden=await ev("(()=>{const b=document.querySelector('.dshwv-menu-btn');return {visible:b.classList.contains('dshwv-menu-btn-visible'),opacity:Number(getComputedStyle(b).opacity)};})()");
      assert.equal(hidden.visible,false);assert.equal(hidden.opacity,0);
      menuEntry.hidden=hidden;
    }
    report.checks.push('slow and fast alpha-to-menu paths cross a pass-through gap without button flicker, accept real Electron clicks, and leave no hidden button hotspot');
    }
    // Reproduce a maximized Codex client extending two DIP into the taskbar.
    // Inspect the actual native region, including the sprite's drop shadow.
    const edgeDip={...dip,y:area.y+area.height-dip.height+2};
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:screen.dipToScreenRect(null,edgeDip)});
    backdrop.setBounds(window.getBounds());
    await delay(450);
    const viewportBottom=area.y+area.height-window.getContentBounds().y;
    for(const size of [.6,1,2.5]){
      await ev(`__whaleRenderTest.close();__whaleRenderTest.scale(${size});__whaleRenderTest.place(140,100000,false)`);
      await delay(650);
      const geometry=await ev("document.querySelector('.dshwv-img').getBoundingClientRect().toJSON()");
      const points=[[Math.round((geometry.left+geometry.width/2)*scale),Math.round((viewportBottom+1)*scale)]];
      const native=await probe({points});
      report.samples.push({cycle:'taskbar-edge',size,viewportBottom,geometry,native});
      assert.ok(geometry.bottom<=viewportBottom+.1,'sprite edge must remain above the taskbar');
      assert.equal(native.contains[0],false,'taskbar pixels cannot be in the native drawing region');
      assert.ok(native.rectangles.every(r=>r[3]<=Math.round(Math.floor(viewportBottom)*scale)),'sprite shadow must also stop at the work area');
    }
    report.checks.push('sprite and shadow remain above the real taskbar when the host client extends two DIP below the work area, at three sprite sizes');
    // Verify preflight before the first move. During movement Python samples
    // HRGN independently; there is no settle/renderer round trip at each step.
    await ev('__whaleRenderTest.close();__whaleRenderTest.scale(1);__whaleRenderTest.place(140,140,false)');await delay(500);
    let dragPoint=await petPoint();assert.ok(dragPoint);setTestCursor(dragPoint);
    window.webContents.sendInputEvent({type:'mouseMove',...dragPoint});await delay(60);
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...dragPoint});await delay(35);
    const dragBounds=window.getContentBounds();
    const guardPoints=[[2,2],[dragBounds.width-2,2],[2,viewportBottom-2],[dragBounds.width-2,viewportBottom-2]].map(p=>p.map(v=>Math.round(v*scale)));
    const dragGuard=await probe({points:guardPoints});
    report.samples.push({cycle:'drag-preflight',dragGuard});
    assert.equal(dragGuard.rectangles.length,1,'drag preflight installs one continuous work-area region');
    assert.ok(dragGuard.contains.every(Boolean),'drag preflight covers every future path corner');
    await ev(`(()=>{const trace=window.__whaleDragTrace={moves:0,minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity};window.__whaleDragTraceMove=()=>{if(!document.querySelector('.dshwv-root.dshwv-dragging'))return;const r=document.querySelector('.dshwv-img').getBoundingClientRect();trace.moves++;trace.minX=Math.min(trace.minX,r.left);trace.maxX=Math.max(trace.maxX,r.left);trace.minY=Math.min(trace.minY,r.top);trace.maxY=Math.max(trace.maxY,r.top);};document.addEventListener('pointermove',__whaleDragTraceMove,true);})()`);
    const moveStart=Date.now();let moveCount=0;
    const motion=setInterval(()=>{
      const t=(Date.now()-moveStart)/1000;
      const x=Math.round(30+Math.abs(Math.sin(t*14))*(dragBounds.width-80));
      const y=Math.round(30+Math.abs(Math.cos(t*10))*(viewportBottom-90));
      window.webContents.sendInputEvent({type:'mouseMove',x,y});moveCount++;
    },4);
    let moving;
    try { moving=await capture('continuous-drag',{watchMs:1800,watchPoints:guardPoints,points:guardPoints}); }
    finally {clearInterval(motion);}
    const mouseTrace=await ev('(()=>{document.removeEventListener("pointermove",__whaleDragTraceMove,true);return __whaleDragTrace;})()');
    report.samples.push({cycle:'continuous-drag',moveCount,mouseTrace,native:moving});
    assert.ok(moveCount>=30&&mouseTrace.moves>=20,'continuous drag must actually process repeated independent moves');
    assert.ok(mouseTrace.maxX-mouseTrace.minX>100&&mouseTrace.maxY-mouseTrace.minY>100,'rendered sprite must cross a large path on both axes during native sampling');
    assert.ok(moving.watch.samples>=100,'native sampling runs independently during drag');
    assert.equal(moving.watch.unknownSamples,0,'every continuous drag sample must read a valid native region');
    assert.equal(moving.watch.validSamples,moving.watch.samples,'old native regions cannot stand in for unreadable samples');
    assert.deepEqual(moving.watch.misses,[],'no future drag path corner can leave the drawing region');
    const releasePoint={x:Math.round(dragBounds.width*.53),y:Math.round(viewportBottom*.47)};
    setTestCursor(releasePoint);window.webContents.sendInputEvent({type:'mouseMove',...releasePoint});window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...releasePoint});
    await delay(650);assert.equal(await ev('__whaleShapeTest.status().dragDrawing'),false,'drop restores bounded surfaces');
    const releasedGeometry=await ev("document.querySelector('.dshwv-img').getBoundingClientRect().toJSON()");
    const released=await probe({points:[[Math.round((releasedGeometry.left+releasedGeometry.width/2)*scale),Math.round((releasedGeometry.top+releasedGeometry.height/2)*scale)],[2,2]]});
    assert.equal(released.contains[1],false,'drop releases the remote work-area corner');
    report.checks.push('synchronous drag preflight covers rapid mouse motion requested by a 4ms timer with independent native HRGN samples; drop restores precise regions');
    for(const ending of ['pointercancel','lostpointercapture','blur','mode-changing']){
      await ev('__whaleRenderTest.close();__whaleRenderTest.place(140,140,false)');await delay(500);
      if (!dragOnly) { window.focus();await wait('document.hasFocus()','cancel fixture focus'); }
      const point=await petPoint();assert.ok(point);setTestCursor(point);
      window.webContents.sendInputEvent({type:'mouseMove',...point});await delay(40);
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});await delay(40);
      assert.equal(await ev('__whaleShapeTest.status().dragDrawing'),true,'abnormal-ending fixture begins a protected drag');
      await ev(`(()=>{const r=document.querySelector('.dshwv-root');if(${JSON.stringify(ending)}==='blur')window.dispatchEvent(new Event('blur'));else if(${JSON.stringify(ending)}==='mode-changing')window.dispatchEvent(new Event('whale-mode-changing'));else r.dispatchEvent(new PointerEvent(${JSON.stringify(ending)},{bubbles:true,pointerId:1}));})()`);
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      await delay(650);
      assert.equal(await ev('__whaleShapeTest.status().dragDrawing'),false,ending+' restores drawing regions');
      const native=await probe({points:[[2,2]]});assert.equal(native.contains[0],false,ending+' releases the remote region');
      report.samples.push({cycle:'drag-'+ending,native});
    }
    report.checks.push('cancel, lost capture, blur and display-mode changes all release the drag drawing region');
    report.ok=true;
  } catch(error) { report.error=error.stack; throw error; }
  finally {
    fs.writeFileSync(path.join(output,'surface-lifecycle.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(output,'desktop-audit.json'),JSON.stringify(report,null,2));
    helper?.stdin.end(JSON.stringify({quit:true})+'\n');
    if(backdrop&&!backdrop.isDestroyed()){ window.setParentWindow(null);backdrop.destroy(); }
    app.quit();
  }
}
