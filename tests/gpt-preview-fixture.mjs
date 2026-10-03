import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

export async function verifyDesktop({app,window,screen,setHost,dataDir,dispatcher}) {
  const output=path.resolve(process.env.WHALE_DESKTOP_VERIFY_DIR);
  fs.mkdirSync(output,{recursive:true});
  const report={ok:false,checks:[]},ev=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){error.message+=' Preview script: '+code;throw error;}};
  async function wait(code){const end=Date.now()+8000;while(Date.now()<end){if(await ev(code))return;await delay(40);}throw Error('Preview did not settle: '+code+' '+JSON.stringify(await ev('({state:__whaleRenderTest?.status(),errors:window.__previewErrors})')));}
  async function capture(name){await delay(700);const rect=await ev("(()=>{const r=document.querySelector('.dshwv-pop').getBoundingClientRect(),x=Math.max(0,Math.floor(r.left-8)),y=Math.max(0,Math.floor(r.top-8));return {x,y,width:Math.min(innerWidth-x,Math.ceil(r.width+16)),height:Math.min(innerHeight-y,Math.ceil(r.height+16))};})()");fs.writeFileSync(path.join(output,name+'.png'),(await window.webContents.capturePage(rect)).toPNG());}
  async function reload(){await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload();});}
  try {
    const area=screen.getPrimaryDisplay().workArea;
    await setHost({hostAlive:true,hostPid:123456,window:'0',visible:true,attached:true,bounds:screen.dipToScreenRect(null,{x:area.x+20,y:area.y+20,width:750,height:650})});
    window.setAlwaysOnTop(true);window.showInactive();
    await ev("window.__previewErrors=[];document.querySelector('.dshwv-text').addEventListener('whale-frame-error',e=>__previewErrors.push(e.detail));");
    await wait("document.querySelector('.dshwv-img')?.naturalWidth>0 && window.__whaleRenderTest?.status().balance===12.3456 && __whaleRenderTest.status().usageSettingsReady && !__whaleRenderTest.status().busy && WhaleAccountView.mode==='api' && !!window.WhaleReferenceAudio");
    await delay(1800);
    await wait("document.querySelector('select[title^=\"选择任务结束音\"]')?.value==='frag:end_a'");
    assert.equal(await ev('WhaleFeedbackSources.success'),'/dsh-whale/audio-fragment.wav?id=end_a');
    const audio=await ev("(async()=>{const r=await fetch('/dsh-whale/audio-fragment.wav?id=end_a');if(!r.ok)throw Error('A unavailable');const context=new AudioContext({sampleRate:48000});try{const b=await context.decodeAudioData(await r.arrayBuffer());return {channels:b.numberOfChannels,sampleRate:b.sampleRate,duration:b.duration};}finally{await context.close();}})()");
    assert.equal(audio.channels,2);assert.equal(audio.sampleRate,48000);assert.ok(audio.duration>1.6&&audio.duration<1.7);
    await ev("(()=>{window.__previewAudio=[];window.__previewOriginalAudio=WhaleReferenceAudio;window.WhaleReferenceAudio={...WhaleReferenceAudio,sound:url=>{const audio={volume:1,play:()=>{__previewAudio.push({url,preset:'original',volume:audio.volume});return Promise.resolve();}};return audio;}};const v=document.querySelector('.dshwv-range[type=range][max=\"1\"]');if(!v)throw Error('Volume control missing');v.value=.1;v.dispatchEvent(new Event('input',{bubbles:true}));})()");
    const turn={id:'preview-completion-a',sessionId:'preview-session',turnId:'preview-completion-a',ts:Date.now(),byModel:{fixture:{input_tokens:100,output_tokens:20}}};
    dispatcher.whale.beginTurn(turn);
    await dispatcher.whale.finishTurn({...turn,ts:Date.now(),outcome:'completed'});
    await wait("__previewAudio.some(o=>o.url==='/dsh-whale/audio-fragment.wav?id=end_a'&&o.preset==='original'&&o.volume===.1)");
    await delay(1200);
    assert.equal(await ev("__previewAudio.filter(o=>o.url==='/dsh-whale/audio-fragment.wav?id=end_a').length"),1);
    await ev("(()=>{window.WhaleReferenceAudio=__previewOriginalAudio;const v=document.querySelector('.dshwv-range[type=range][max=\"1\"]');v.value=0;v.dispatchEvent(new Event('input',{bubbles:true}));__whaleRenderTest.close();})()");
    await delay(350);
    report.checks.push('completion A is selected, Chromium decodes its original stereo WAV, and one completed turn invokes it once at the exact inherited volume');
    await ev("__whaleRenderTest.place(330,350,false); __whaleRenderTest.open()");
    await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching");
    await capture('api-balance');
    assert.equal(await ev("document.querySelector('.dshwv-frame:not([inert])').textContent.includes('今日已消耗')"),true);
    assert.equal(await ev("document.querySelector('.dshwv-frame:not([inert])').textContent.includes('剩余重置')"),false);
    await ev("__whaleRenderTest.close(); __whaleRenderTest.showCost(.12,WhaleTurnNotice.snapshot({amount:.12,currency:'USD',tokens:100,costState:'observed'}))");
    await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching");
    await capture('api-cost');
    await ev('__whaleRenderTest.close()');
    dispatcher.whale.writeUsageSettings({budget:{on:true,amount:2,autoClose:false}});
    await reload();
    await wait("document.querySelector('.dshwv-img')?.naturalWidth>0 && !!window.__whaleRenderTest && __whaleRenderTest.status().usageSettingsReady && !__whaleRenderTest.status().busy && WhaleAccountView.mode==='api'");
    await delay(1800);
    dispatcher.whale.provider.amount=9.3456;
    await ev('__whaleRenderTest.refresh(true)');
    await wait("__whaleRenderTest.status().scene==='alert'&&!__whaleRenderTest.status().switching");
    const reminderRows=await ev("[...document.querySelector('.dshwv-frame:not([inert])').querySelectorAll('.dshwv-trow')].map(e=>e.textContent)");
    assert.equal(reminderRows[0],'老大～今天花销超过');
    assert.match(reminderRows[1],/2\.00/);
    assert.equal(reminderRows[2],'再花就要变穷光蛋啦～');
    assert.equal(await ev(`(()=>{const frame=document.querySelector('.dshwv-frame:not([inert])'),box=document.querySelector('.dshwv-text').getBoundingClientRect();return [...frame.querySelectorAll('.dshwv-trow')].every(row=>{const r=row.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(row);const tops=new Set([...range.getClientRects()].map(rect=>Math.round(rect.top)));return tops.size===1&&r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1;});})()`),true,'default high-use reminder must fit without orphaned wrapping');
    await capture('daily-budget');
    dispatcher.whale.writeUsageSettings({budget:{on:false}});
    await ev('__whaleRenderTest.close()');
    report.checks.push('today consumption uses its new label; a changed daily budget triggers the editable three-line reminder');
    dispatcher.whale.writeUsageSettings({alert:{on:true,below:5,autoClose:false}});
    await reload();
    await wait("document.querySelector('.dshwv-img')?.naturalWidth>0 && !!window.__whaleRenderTest && __whaleRenderTest.status().usageSettingsReady && !__whaleRenderTest.status().busy && WhaleAccountView.mode==='api'");
    await delay(1800);
    dispatcher.whale.provider.amount=4;
    await ev('__whaleRenderTest.refresh(true)');
    await wait("__whaleRenderTest.status().scene==='alert'&&!__whaleRenderTest.status().switching");
    const alertText=await ev("document.querySelector('.dshwv-frame:not([inert])').textContent");
    assert.match(alertText,/老大～你的 API 余额/);assert.match(alertText,/已经不足 \$5\.00 啦～/);assert.match(alertText,/给大肥龙加餐/);
    await wait("document.querySelector('.dshwv-frame:not([inert]) .dshwv-mimg')?.naturalWidth>0");
    const alertImage=await ev("(()=>{const img=document.querySelector('.dshwv-frame:not([inert]) .dshwv-mimg');return {source:img?.currentSrc,loaded:!!img?.naturalWidth};})()");
    assert.equal(alertImage.loaded,true);assert.match(alertImage.source,/bimg_yue_money/);
    await capture('low-balance');
    dispatcher.whale.writeUsageSettings({alert:{on:false}});await ev('__whaleRenderTest.close()');
    report.checks.push('low balance uses the original modular image and account link with the new Lao Da wording');
    const codex=path.join(dataDir,'fixture-codex');
    fs.writeFileSync(path.join(codex,'config.toml'),'model_provider="openai"\n');
    const auth=path.join(codex,'auth.json');fs.writeFileSync(auth,JSON.stringify({auth_mode:'chatgpt'}));fs.utimesSync(auth,new Date(Date.now()-60000),new Date(Date.now()-60000));
    fs.writeFileSync(path.join(dataDir,'display-mode.json'),JSON.stringify({mode:'auto'}));
    fs.mkdirSync(path.join(codex,'sessions'),{recursive:true});
    const now=Date.now();
    fs.writeFileSync(path.join(codex,'sessions','rollout-preview.jsonl'),JSON.stringify({type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'token_count',rate_limits:{primary:{used_percent:16,window_minutes:300,resets_at:Math.floor(now/1000)+3600},secondary:{used_percent:18,window_minutes:10080,resets_at:Math.floor(now/1000)+86400}}}})+'\n');
    assert.equal(await ev('WhaleAccountView.syncMode()'),true);
    assert.equal(await ev('WhaleAccountView.mode'),'subscription');
    await ev('WhaleAccountView.refresh()');
    for(const scale of [.6,1,2.5]) {
      await ev(`__whaleRenderTest.close(); __whaleRenderTest.scale(${scale}); __whaleRenderTest.place(300,350,false); __whaleRenderTest.open()`);
      await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching");
      const result=await ev(`(()=>{const f=document.querySelector('.dshwv-frame:not([inert])'),box=document.querySelector('.dshwv-text').getBoundingClientRect(),rows=[...f.querySelectorAll('.dshwv-trow')];return {texts:rows.map(r=>r.textContent),sizes:rows.map(r=>parseFloat(getComputedStyle(r).fontSize)),inside:rows.every(r=>{const b=r.getBoundingClientRect();return b.left>=box.left-1&&b.right<=box.right+1&&b.top>=box.top-1&&b.bottom<=box.bottom+1;})};})()`);
      assert.deepEqual(result.texts,['剩余 84%','每周 剩余 82%','剩余重置 2 次']);
      assert.ok(result.sizes[0]>result.sizes[1]);assert.equal(result.inside,true);
      if(scale===2.5)await capture('subscription');
      report.checks.push('compact quota and official reset count fit the bubble at scale '+scale);
    }
    await ev("(()=>{const data=WhaleAccountView.insights;data.subscription.resetCredits={state:'observed',availableCount:0};window.dispatchEvent(new CustomEvent('whale-insights',{detail:data}));})()");
    assert.equal(await ev("document.querySelector('.dshwv-frame:not([inert])').textContent.includes('剩余重置 0 次')"),true);
    report.checks.push('an already open official quota bubble updates zero resets and API bubbles omit resets');
    await ev("__whaleRenderTest.close();__whaleRenderTest.showCost(null,WhaleTurnNotice.subscriptionSnapshot({tokens:12480,amount:99,currency:'USD',outcome:'completed',quotaDelta:{state:'observed',percent:2}}))");
    await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching");
    assert.deepEqual(await ev("[...document.querySelector('.dshwv-frame:not([inert])').querySelectorAll('.dshwv-trow')].map(e=>e.textContent)"),['上一轮对话消耗：','2%','吃了 12,480 token']);
    await ev("window.dispatchEvent(new CustomEvent('whale-insights',{detail:WhaleAccountView.insights}))");
    assert.deepEqual(await ev("[...document.querySelector('.dshwv-frame:not([inert])').querySelectorAll('.dshwv-trow')].map(e=>e.textContent)"),['上一轮对话消耗：','2%','吃了 12,480 token']);
    await capture('tokens');
    await ev("__whaleRenderTest.close();__whaleRenderTest.showCost(null,WhaleTurnNotice.subscriptionSnapshot({tokens:12480,outcome:'completed'}))");
    await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching");
    assert.equal(await ev("document.querySelector('.dshwv-frame:not([inert])').textContent.includes('额度变化未知')"),true);
    await ev("__whaleRenderTest.close();fetch('/dsh-whale/usage-settings.json',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({turnCost:{lines:[{type:'text',text:'自定义消耗 {consumption} / {tokens}',size:6,bold:true}]}})}).then(r=>r.json()).then(d=>{if(!d.ok)throw Error('Custom template was not saved');window.__previewReloadMark=true;})");
    await reload();
    await wait("window.__previewReloadMark!==true && document.readyState==='complete' && document.querySelector('.dshwv-img')?.naturalWidth>0 && !!window.__whaleRenderTest && WhaleAccountView.mode==='subscription'");
    await delay(1800);
    await ev("__whaleRenderTest.showCost(null,WhaleTurnNotice.subscriptionSnapshot({tokens:4321,outcome:'completed',quotaDelta:{state:'observed',percent:.5}}))");
    await wait("__whaleRenderTest.status().shown&&!__whaleRenderTest.status().switching");
    assert.deepEqual(await ev("[...document.querySelector('.dshwv-frame:not([inert])').querySelectorAll('.dshwv-trow')].map(e=>e.textContent)"),['自定义消耗 0.5% / 4,321']);
    report.checks.push('saved custom consumption modules survive a renderer reload and resolve quota and token placeholders');
    report.checks.push('API balance and money notices render; subscription removes API money and shows token template');
    report.ok=true;
  }catch(error){report.error=error.stack;throw error;}
  finally{fs.writeFileSync(path.join(output,'gpt-preview.json'),JSON.stringify(report,null,2));app.quit();}
}
