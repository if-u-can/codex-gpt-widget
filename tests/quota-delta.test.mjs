import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhaleService } from '../runtime/service.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';

const usage = count => ({ model: { input_tokens: count, output_tokens: 0, cached_input_tokens: 0 } });
const round = (id, extra = {}) => ({ id: 'main:' + id, sessionId: 'main', turnId: id, rootTurnId: id, ...extra });
function snapshot(percent, observedAt, resetAt, extra = {}) {
  return { ok: true, error: null, subscription: { available: true, observedAt,
    windows: [{ label: '5 小时', windowDurationMins: 300, usedPercent: percent,
      remainingPercent: 100 - percent, resetsAt: resetAt, observedAt, stale: false }], ...extra } };
}
function fixture(t, { key = '', snapshots = [], reader = null, models = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-quota-delta-')), services = [];
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'FIXTURE_ACCOUNT_A', access_token: 'FIXTURE_TOKEN' } }));
  const connection = { id: 'openai', key, accountId: 'a'.repeat(24), baseUrl: 'https://api.openai.com/v1', model: 'model',
    dashboardUrl: '', setting: { provider: 'auto', currency: 'USD', refreshSeconds: 60, monitorSessions: true, models } };
  const config = { dataDir: dir, codexHome: dir, resolve: () => connection };
  let quotaCalls = 0, balanceCalls = 0, used = 0;
  const quotaReader = async options => { assert.equal(options.force, true); const index = quotaCalls++; return reader ? reader(index) : snapshots[index]; };
  const provider = { async balance(c) { balanceCalls++; return { ok: true, accountId: c.accountId, currency: 'USD', totalUsed: used, totalBalance: 100 - used }; } };
  const make = () => { const service = new WhaleService({ config, provider, quotaReader }); services.push(service); return service; };
  t.after(async () => {
    for (const service of services) await service.close({ timeoutMs: 50 });
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dir).startsWith('gpt-quota-delta-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { config, connection, authFile, make, scope: connection.accountId + '-USD',
    calls: () => ({ quota: quotaCalls, balance: balanceCalls }), setUsed: value => { used = value; } };
}

test('a complete subscription round publishes its five-hour snapshot difference without billing the percentage', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(12.25, now - 1000, now + 3600000), snapshot(14.5, now, now + 3600000)],
    models: { model: { input: 99, cachedInput: 99, output: 99 } } }), service = f.make();
  const meta = round('normal', { startedAt: now - 500 });
  service.beginTurn(meta); await service.finishTurn({ ...meta, ts: now, byModel: usage(250), outcome: 'completed' });
  const last = service.lastTurn();
  assert.deepEqual(last.quotaDelta, { percent: 2.25, state: 'observed', startObservedAt: now - 1000, endObservedAt: now });
  assert.equal(last.tokens, 250); assert.equal(last.amount, null); assert.equal(last.cost, null);
  assert.equal(service.ledger.records(f.scope).today.total, 0);
  assert.deepEqual(f.calls(), { quota: 2, balance: 0 });
});

test('an unchanged percentage from a newer snapshot is an observed zero', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(25, now - 1000, now + 3600000), snapshot(25, now, now + 3600000)] }), service = f.make();
  const meta = round('zero', { startedAt: now - 500 }); service.beginTurn(meta);
  await service.finishTurn({ ...meta, ts: now, byModel: usage(20) });
  assert.equal(service.lastTurn().quotaDelta?.state, 'observed'); assert.equal(service.lastTurn().quotaDelta?.percent, 0);
});

for (const [name, change] of [
  ['a reset window', (s, e) => { e.subscription.windows[0].resetsAt += 1000; }],
  ['a stale start', s => { s.subscription.windows[0].stale = true; }],
  ['a stale end', (_s, e) => { e.subscription.windows[0].stale = true; }],
  ['a missing end', (_s, e) => { e.subscription.windows = []; e.subscription.available = false; }],
  ['a decreasing meter', (_s, e) => { e.subscription.windows[0].usedPercent = 10; }],
  ['the same snapshot twice', (s, e) => { e.subscription.observedAt = s.subscription.observedAt; e.subscription.windows[0].observedAt = s.subscription.observedAt; }],
]) test(name + ' leaves the percentage unknown instead of inventing zero', async t => {
  const now = Date.now(), start = snapshot(20, now - 1000, now + 3600000), end = snapshot(23, now, now + 3600000); change(start, end, now);
  const f = fixture(t, { snapshots: [start, end] }), service = f.make(), meta = round('unknown', { startedAt: now - 500 });
  service.beginTurn(meta); await service.finishTurn({ ...meta, ts: now, byModel: usage(20) });
  assert.equal(service.lastTurn().quotaDelta?.state, 'unknown'); assert.equal(service.lastTurn().quotaDelta?.percent, null);
  assert.equal(service.lastTurn().amount, null); assert.equal(f.calls().balance, 0);
});

test('snapshot interval remains valid when monitor discovery and sampling follow the logged task boundaries', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(20, now - 1000, now + 3600000), snapshot(23, now, now + 3600000)] }), service = f.make();
  const meta = round('discovery-delay', { startedAt: now - 2000 }); service.beginTurn(meta);
  await service.finishTurn({ ...meta, ts: now - 500, byModel: usage(20) });
  assert.equal(service.lastTurn().quotaDelta?.state, 'observed'); assert.equal(service.lastTurn().quotaDelta?.percent, 3);
});

test('settlement awaits the actual start sample before requesting the end', async t => {
  const now = Date.now(); let resolveStart;
  const start = new Promise(resolve => { resolveStart = resolve; });
  const f = fixture(t, { reader: index => index === 0 ? start : snapshot(35, now, now + 3600000) }), service = f.make();
  const meta = round('ordering', { startedAt: now - 500 }); service.beginTurn(meta);
  const finishing = service.finishTurn({ ...meta, ts: now, byModel: usage(1) });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls().quota, 1);
  resolveStart(snapshot(30, now - 1000, now + 3600000)); await finishing;
  assert.equal(service.lastTurn().quotaDelta?.percent, 5);
});

test('partial and historical rounds cannot obtain a full-round quota baseline', async t => {
  const f = fixture(t), service = f.make();
  for (const flags of [{ partial: true }, { historical: true }]) {
    const meta = round(String(Object.keys(flags)[0]), flags); service.beginTurn(meta);
    await service.finishTurn({ ...meta, byModel: usage(10) });
    const saved = service.ledger.find(f.scope, meta);
    assert.equal(saved.quotaDelta?.state, 'unknown'); assert.equal(saved.quotaDelta?.percent, null);
  }
  assert.deepEqual(f.calls(), { quota: 0, balance: 0 });
});

test('a round marked partial only at completion does not publish a whole-round percentage', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(20, now - 1000, now + 3600000), snapshot(23, now, now + 3600000)] }), service = f.make();
  const meta = round('late-partial', { startedAt: now - 500 }); service.beginTurn(meta);
  await service.finishTurn({ ...meta, partial: true, ts: now, byModel: usage(20) });
  assert.equal(service.lastTurn().quotaDelta?.state, 'unknown'); assert.equal(service.lastTurn().quotaDelta?.percent, null);
});

test('an account switch during the initial asynchronous scan invalidates its sample', async t => {
  const now = Date.now(); let release;
  const f = fixture(t, { reader: () => new Promise(resolve => { release = resolve; }) }), service = f.make(), meta = round('scan-switch', { startedAt: now - 500 });
  service.beginTurn(meta);
  fs.writeFileSync(f.authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'FIXTURE_ACCOUNT_B', access_token: 'FIXTURE_TOKEN_B' } }));
  release(snapshot(10, now - 1000, now + 3600000));
  await service.finishTurn({ ...meta, ts: now, byModel: usage(20) });
  assert.equal(service.ledger.find(f.scope, meta).quotaDelta?.state, 'unknown'); assert.equal(f.calls().balance, 0);
});

test('switching subscription accounts hides the previous account notice although its API hash matches', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(10, now - 1000, now + 3600000), snapshot(13, now, now + 3600000)] }), service = f.make();
  const meta = round('last-account', { startedAt: now - 500 }); service.beginTurn(meta);
  await service.finishTurn({ ...meta, ts: now, byModel: usage(10) });
  assert.equal(service.lastTurn().quotaDelta?.percent, 3);
  assert.equal(Object.hasOwn(service.lastTurn(), 'quotaAccountId'), false);
  fs.writeFileSync(f.authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'FIXTURE_ACCOUNT_B', access_token: 'FIXTURE_TOKEN_B' } }));
  assert.equal(service.lastTurn().turn, null); assert.equal(service.lastTurn().tokens, null);
});

test('subscription account changes invalidate the interval even when the API connection hash is unchanged', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(12, now - 1000, now + 3600000), snapshot(30, now, now + 3600000)] }), service = f.make();
  const meta = round('switch', { startedAt: now - 500 }); service.beginTurn(meta);
  await service.turns.get(meta.id).quotaStart;
  fs.writeFileSync(f.authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'FIXTURE_ACCOUNT_B', access_token: 'FIXTURE_TOKEN_B' } }));
  await service.finishTurn({ ...meta, ts: now, byModel: usage(1) });
  const record = service.ledger.find(f.scope, meta);
  assert.equal(record.quotaDelta?.state, 'unknown'); assert.equal(record.quotaDelta?.percent, null);
});

test('a late child revises token totals once without resampling or changing the root percentage', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(50, now - 1000, now + 3600000), snapshot(52, now, now + 3600000)] }), service = f.make();
  const root = round('parent', { startedAt: now - 500 }); service.beginTurn(root);
  await service.finishTurn({ ...root, ts: now, byModel: usage(100) });
  const child = { id: 'child:turn', sessionId: 'child', turnId: 'turn', rootTurnId: root.turnId, isSubagent: true };
  service.beginTurn(child); await service.finishTurn({ ...child, ts: now, byModel: usage(20), notify: false });
  service.beginTurn(child); await service.finishTurn({ ...child, ts: now, byModel: usage(20), notify: false });
  assert.equal(service.lastTurn().tokens, 120); assert.equal(service.lastTurn().seq, 1);
  assert.equal(service.lastTurn().quotaDelta?.percent, 2); assert.deepEqual(f.calls(), { quota: 2, balance: 0 });
});

test('an active subscription round recovered from a journal has an unknown baseline and makes no billing call', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(40, now - 1000, now + 3600000)] }), first = f.make();
  const meta = round('recover', { startedAt: now - 500 }); first.beginTurn(meta);
  await first.turns.get(meta.id).quotaStart; await first.close();
  const recovered = f.make(); recovered.prepareRecovery();
  await recovered.finishTurn({ ...meta, ts: now, byModel: usage(10) });
  const record = recovered.ledger.find(f.scope, meta);
  assert.equal(record.quotaDelta?.state, 'unknown'); assert.equal(record.quotaDelta?.percent, null);
  assert.equal(record.notify, false); assert.equal(recovered.lastTurn().turn, null);
  assert.equal(f.calls().balance, 0);
});

test('restored subscription rounds cannot be rebound or later notified under another login', async t => {
  const now = Date.now(), f = fixture(t, { snapshots: [snapshot(40, now - 1000, now + 3600000)] }), first = f.make();
  const meta = round('recover-switch', { startedAt: now - 500 }); first.beginTurn(meta);
  await first.turns.get(meta.id).quotaStart; first.updateTurn({ ...meta, byModel: usage(88) }); await first.close();
  fs.writeFileSync(f.authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'FIXTURE_ACCOUNT_B', access_token: 'FIXTURE_TOKEN_B' } }));
  const recovered = f.make(); recovered.prepareRecovery();
  await recovered.finishTurn({ ...meta, ts: now, outcome: 'failed', statusNotify: true });
  const record = recovered.ledger.find(f.scope, meta);
  assert.equal(record.quotaAccountId, null); assert.equal(record.quotaDelta?.state, 'unknown');
  assert.equal(record.tokens, 88); assert.equal(record.notify, false);
  assert.equal(recovered.lastTurn().turn, null); assert.equal(recovered.lastTurn().tokens, null);
  await recovered.finishTurn({ ...meta, outcome: 'aborted', statusCorrection: true });
  assert.equal(recovered.ledger.find(f.scope, meta).notify, false);
  assert.equal(recovered.lastTurn().turn, null); assert.equal(recovered.lastTurn().tokens, null);
  assert.deepEqual(f.calls(), { quota: 1, balance: 0 });
});

test('a saved subscription notice without its original login identity is hidden', t => {
  const f = fixture(t), service = f.make();
  fs.writeFileSync(service.lastFile, JSON.stringify({ ok: true, seq: 1, turn: 'legacy-quota', tokens: 88,
    accountId: f.connection.accountId, source: 'subscription-quota-interval', quotaDelta: { state: 'unknown', percent: null } }));
  assert.equal(service.lastTurn().turn, null); assert.equal(service.lastTurn().tokens, null);
});

test('an API key retains the existing start/end balance path even with subscription tokens present', async t => {
  const f = fixture(t, { key: 'FIXTURE_API_KEY' }), service = f.make(), meta = round('api');
  service.beginTurn(meta); await service.turns.get(meta.id).start; f.setUsed(3);
  await service.finishTurn({ ...meta, byModel: usage(100) });
  assert.equal(service.lastTurn().amount, 3); assert.equal(service.lastTurn().quotaDelta, undefined);
  assert.deepEqual(f.calls(), { quota: 0, balance: 2 });
});

test('dispatcher supplies the real local-log reader for subscription settlement without an API query', async t => {
  const now = Date.now(), f = fixture(t), service = f.make(); service.quotaReader = null;
  fs.utimesSync(f.authFile, new Date(now - 5000), new Date(now - 5000));
  const sessions = path.join(f.config.codexHome, 'sessions'); fs.mkdirSync(sessions);
  const log = path.join(sessions, 'rollout-quota-fixture.jsonl'), reset = Math.floor((now + 3600000) / 1000);
  const event = (percent, at) => JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(),
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: reset } } } }) + '\n';
  fs.writeFileSync(log, event(10, now - 1000));
  const dispatcher = createDispatcher({ dataDir: f.config.dataDir, service, monitor: false, autoRefresh: false });
  try {
    const meta = round('real-reader', { startedAt: now - 500 }); service.beginTurn(meta);
    await service.turns.get(meta.id).quotaStart;
    fs.appendFileSync(log, event(12, now));
    await service.finishTurn({ ...meta, ts: now, byModel: usage(20) });
    assert.equal(service.lastTurn().quotaDelta?.percent, 2); assert.equal(f.calls().balance, 0);
  } finally { await dispatcher.close(); }
});
