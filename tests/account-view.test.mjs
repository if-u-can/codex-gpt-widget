import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../desktop/ui/account-view.js', import.meta.url), 'utf8');
const exported = { module: { exports: {} } }; vm.runInNewContext(source, exported);
const { windowText, tokenText, noticeText, quotaLabel } = exported.module.exports;

test('compact quota percentages retain the main and smaller weekly line',()=>{
  const {quotaBubbleText}=exported.module.exports;
  const sub={windows:[{windowDurationMins:300,usedPercent:16},{windowDurationMins:10080,usedPercent:18}]};
  assert.equal(quotaBubbleText(sub,300),'剩余 84%');
  assert.equal(quotaBubbleText(sub,10080),'每周 剩余 82%');
  assert.equal(quotaBubbleText({},300),'剩余 --');
  assert.equal(quotaBubbleText({windows:[{windowDurationMins:300,usedPercent:100}]},300),'剩余 0%');
});
test('official reset count distinguishes observed zero from missing or invalid data',()=>{
  const {quotaResetText}=exported.module.exports;
  assert.equal(quotaResetText({resetCredits:{state:'observed',availableCount:2}}),'剩余重置 2 次');
  assert.equal(quotaResetText({resetCredits:{state:'observed',availableCount:0}}),'剩余重置 0 次');
  assert.equal(quotaResetText({}),'剩余重置 -- 次');
  assert.equal(quotaResetText({resetCredits:{state:'unknown',availableCount:2}}),'剩余重置 -- 次');
  for(const availableCount of [null,undefined,NaN,Infinity,-1,1.5,'2']) assert.equal(quotaResetText({resetCredits:{state:'observed',availableCount}}),'剩余重置 -- 次');
});

test('automatic mode follows server-detected key changes and preserves mode on a failed read',async()=>{
  let detected='api';
  const r=runtime(async()=>({ok:true,json:async()=>({ok:true,mode:detected,automatic:true})}));
  await r.api.syncMode();assert.equal(r.api.mode,'api');
  detected='subscription';await r.api.syncMode();assert.equal(r.api.mode,'subscription');
  detected='invalid';assert.equal(await r.api.syncMode(),false);assert.equal(r.api.mode,'subscription');
  assert.equal(r.events.filter(e=>e.type==='whale-account-view').length,2);
});
test('manual refresh forces reset counts while scheduled refresh uses the normal cache',async()=>{
  const routes=[],r=runtime(async route=>{routes.push(route);return {ok:true,json:async()=>({ok:true,subscription:{windows:[]}})};});
  await r.api.refresh(false);
  await r.api.refresh();
  assert.deepEqual(routes,['/api/insights','/api/insights?refresh=1']);
});

test('quota periods remain distinct regardless of incoming label',()=>{
  assert.equal(quotaLabel({windowDurationMins:300,label:'primary'}),'5 小时额度');
  assert.equal(quotaLabel({windowDurationMins:10080,label:'secondary'}),'每周额度');
  assert.equal(quotaLabel({windowDurationMins:60,label:'独立窗口'}),'独立窗口');
});

test('missing snapshot values never become zero quota or tokens', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '50']) {
    assert.equal(windowText({ usedPercent: value }), '额度比例未知');
    assert.equal(tokenText(value), '暂无记录');
  }
  assert.match(windowText({ usedPercent: 25.5, stale: true }), /已用 25.5% · 剩余 74.5%（快照已过期）/);
  assert.equal(tokenText(0), '0 token');
});
test('subscription failure consumption displays tokens without API money or fun failure text', () => {
  assert.equal(noticeText({ completionKind: 'failed', tokens: 10, amount: 5 }), '本轮未完成 · 本机已观测 10 token');
  assert.equal(noticeText({ completionKind: 'failed', failureKind: 'high-demand' }), '本轮请求未完成：服务繁忙');
  assert.equal(noticeText({ completionKind: 'completed', tokens: 10, amount: 5 }), '这轮吃了 10 token（本机已观测）');
  assert.equal(noticeText({ completionKind: 'cancelled', tokens: null }), '本轮已取消 · 用量暂无记录');
  assert.equal(noticeText({ completionKind: 'success', tokens: null }), '这轮用量暂无记录');
});
function runtime(fetch) {
  const storage = new Map(); const events = [];
  const context = { document: { documentElement: {dataset:{}}, readyState: 'loading', addEventListener() {}, querySelectorAll(){return []} }, window: { dispatchEvent(e) { events.push(e); } }, localStorage: { getItem(k) { return storage.get(k); }, setItem(k,v) { storage.set(k,v); } }, fetch, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } };
  vm.runInNewContext(source, context);
  return { api: context.window.WhaleAccountView, storage, events, window:context.window };
}
test('subscription completion refreshes quota without replacing the original consumption bubble with a toast',async()=>{
  const routes=[];
  const r=runtime(async route=>{routes.push(route);return {ok:true,json:async()=>({ok:true,subscription:{available:false,windows:[]},tokens:null})};});
  const messages=[];r.window.whaleToast=message=>messages.push(message);
  assert.equal(r.api.mode,'subscription');
  r.api.notice({completionKind:'success',tokens:12480,amount:100,currency:'USD'});
  r.api.notice({completionKind:'cancelled',tokens:12,amount:10});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(messages.length,0);
  assert.deepEqual(routes,['/api/insights?refresh=1&resets=cache','/api/insights?refresh=1&resets=cache']);
  assert.equal(r.events.filter(e=>e.type==='whale-insights').length,1);
  assert.equal(noticeText({notify:false,tokens:12}),'');
});
test('a rejected save preserves mode and does not emit false switch events', async () => {
  for (const fetch of [async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ mode: 'api' }) }), async () => { throw Error('offline'); }]) {
    const { api, storage, events } = runtime(fetch);
    assert.equal(await api.setMode('subscription'), false);
    assert.equal(api.mode, 'subscription'); assert.equal(storage.size, 0); assert.equal(events.length, 0);
  }
});
test('successful switches persist display mode only after server acknowledgement', async () => {
  let resolve; let request;
  const { api, storage, events } = runtime((url, options) => { request = { url, options }; return new Promise(r => { resolve = r; }); });
  const pending = api.setMode('api');
  assert.equal(api.mode, 'subscription'); assert.equal(storage.size, 0);
  assert.equal(await api.setMode('subscription'), false);
  resolve({ ok: true, json: async () => ({ mode: 'api' }) });
  assert.equal(await pending, true); assert.equal(api.mode, 'api');
  assert.equal(storage.get('dshw-account-view'), 'api');
  assert.equal(request.url, '/api/display-mode'); assert.equal(request.options.body, '{"mode":"api"}');
  assert.equal(events[0].type, 'whale-account-view'); assert.equal(events[0].detail.mode, 'api');
});
