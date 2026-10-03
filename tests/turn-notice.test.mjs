import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const box = { module: { exports: {} } };
vm.runInNewContext(await fs.readFile(new URL('../desktop/ui/turn-notice.js', import.meta.url), 'utf8'), box);
const notices = box.module.exports;
const record = extra => ({ ok: true, seq: 8, id: 'root-1:turn-2', turn: 'turn-2', ts: 1000, notificationAt: 4000,
  outcome: 'completed', amount: 0.123456, currency: 'USD', tokens: 1200, costState: 'observed', ...extra });

test('fresh ordinary failures and cancellations show consumption while old outcomes remain silent', () => {
  assert.equal(notices.shouldNotify(record({ outcome:'failed' }), { firstPoll: true, startedAt: 3000 }), true);
  assert.equal(notices.shouldNotify(record({ outcome:'aborted' }), { firstPoll: true, startedAt: 3000 }), true);
  assert.equal(notices.shouldNotify(record({ outcome: 'failed', failureKind: 'high-demand' }), { firstPoll: true, startedAt: 3000 }), true);
  assert.equal(notices.shouldNotify(record({ notificationAt: 2000 }), { firstPoll: true, startedAt: 3000 }), false);
  assert.equal(notices.shouldNotify(record({ notificationAt: null, ts: 4000 }), { firstPoll: true, startedAt: 3000 }), true);
});

test('child turns, restored turns and same-sequence cost revisions cannot reopen bubbles or replay audio', () => {
  const last = { seq: 8, id: 'root-1:turn-2' };
  assert.equal(notices.shouldNotify(record({ amount: 3 }), last), false);
  assert.equal(notices.shouldNotify(record({ seq: 9, isSubagent: true }), {}), false);
  assert.equal(notices.shouldNotify(record({ seq: 9, notify: false }), {}), false);
  assert.equal(notices.shouldNotify(record({ seq: 9 }), last), false);
  assert.equal(notices.shouldNotify(record({ seq: 9, id: 'root-1:turn-3' }), last), true);
});

test('a queued notice captures currency, money, text and tokens once', () => {
  let draws = 0;
  const source = record({ outcome: 'failed', failureKind: 'high-demand', amount: null, costState: 'pending' });
  const notice = notices.snapshot(source, 'CNY', () => { draws++; return 0.7; });
  source.amount = 99; source.currency = 'CNY'; source.tokens = 999;
  assert.equal(notice.currency, 'USD'); assert.equal(notice.amount, null); assert.equal(notice.tokens, 1200);
  assert.equal(notice.costState, 'pending'); assert.equal(notice.completionKind, 'failed');
  assert.equal(draws, 0); assert.equal(notice.label, '挤不进去...'); assert.ok(Object.isFrozen(notice));
});

test('unknown charges never become a zero-price success and known zero estimates remain valid', () => {
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(notices.snapshot(record({ amount: value })).amount, null);
  assert.equal(notices.snapshot(record({ amount: 0, costState: 'pending' })).amount, null);
  assert.equal(notices.snapshot(record({ amount: 0, costState: 'estimated' })).amount, 0);
  assert.equal(notices.snapshot(record({ amount: null, costState: 'unknown' })).costState, 'unknown');
});

test('ordinary failure consumption follows the main switch while high-demand keeps its exception', () => {
  const failed = notices.snapshot(record({ outcome: 'failed' }));
  const cancelled = notices.snapshot(record({ outcome: 'aborted' }));
  const success = notices.snapshot(record({}));
  assert.equal(notices.enabled(failed, { failed: true }, false), false);
  assert.equal(notices.enabled(cancelled, { failed: false, cancelled: true }, false), false);
  assert.equal(notices.enabled(cancelled, {}, true), true);
  assert.equal(cancelled.label,'本轮已观测消耗:');assert.equal(cancelled.failureKind,null);
  assert.equal(notices.enabled(notices.snapshot(record({ outcome: 'failed', failureKind: 'high-demand' })), { failed: false }, false), true);
  assert.equal(notices.enabled(failed, { failed: false }, true), true);
  assert.equal(failed.label,'本轮已观测消耗:');assert.equal(failed.failureKind,null);
  assert.equal(notices.enabled(success, { failed: true, cancelled: true }, false), false);
});

test('subscription notices keep tokens and outcome while removing the API amount', () => {
  const source=record({tokens:12480,amount:99});
  const notice=notices.subscriptionSnapshot(source);
  source.tokens=999;
  assert.equal(notice.displayMode,'subscription');assert.equal(notice.amount,null);
  assert.equal(notice.tokens,12480);assert.equal(notice.label,'上一轮对话消耗：');assert.ok(Object.isFrozen(notice));
  assert.equal(notices.templateTokens('这轮吃了 {tokens} token',notice),'这轮吃了 12,480 token');
  assert.equal(notices.subscriptionSnapshot(record({outcome:'aborted'})).label,'上一轮对话消耗：');
  assert.equal(notices.subscriptionSnapshot(record({outcome:'aborted'})).completionKind,'cancelled');
  assert.equal(notices.subscriptionSnapshot(record({outcome:'failed'})).completionKind,'failed');
});

test('subscription templates distinguish unobserved consumption from a known zero', () => {
  for(const value of [null,undefined,NaN,Infinity,-1])assert.equal(notices.templateTokens('{tokens}',{tokens:value}),'用量未知');
  assert.equal(notices.templateTokens('{tokens}',{tokens:0}),'0');
});

test('percentage consumption requires observed quota delta, with unknown distinct from zero',()=>{
  for(const percent of [null,undefined,NaN,Infinity,-1,'2'])assert.equal(notices.quotaText(notices.subscriptionSnapshot(record({quotaDelta:{state:'observed',percent}}))),'额度变化未知');
  assert.equal(notices.quotaText(notices.subscriptionSnapshot(record({quotaDelta:{state:'unknown',percent:0}}))),'额度变化未知');
  assert.equal(notices.quotaText(notices.subscriptionSnapshot(record({quotaDelta:{state:'observed',percent:0}}))),'0%');
  assert.equal(notices.quotaText(notices.subscriptionSnapshot(record({quotaDelta:{state:'observed',percent:2.5}}))),'2.5%');
});
