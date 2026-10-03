(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleTurnNotice = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function kind(record) {
    if (record.completionKind === 'failed' || ['failed','interrupted','superseded'].includes(record.outcome)) return 'failed';
    if (record.completionKind === 'cancelled' || ['aborted', 'cancelled'].includes(record.outcome)) return 'cancelled';
    return 'success';
  }
  function shouldNotify(record, { seq = 0, id = '', firstPoll = false, startedAt = 0 } = {}) {
    if (!record?.ok || !Number.isSafeInteger(record.seq) || record.seq <= seq || !record.id || record.id === id ||
        record.turn == null || record.notify === false || record.isSubagent) return false;
    const published = record.notificationAt || record.ts;
    const at = typeof published === 'number' ? published : Date.parse(published);
    return !firstPoll || Number.isFinite(at) && at >= startedAt;
  }
  function snapshot(record, nativeCurrency = 'USD', random = Math.random) {
    const completionKind = kind(record);
    const known = record.amount !== null && record.amount !== undefined && Number.isFinite(Number(record.amount)) &&
      !['pending', 'unknown'].includes(record.costState);
    const failureKind = completionKind === 'failed' && record.failureKind === 'high-demand' ? 'high-demand' : null;
    return Object.freeze({
      id: String(record.id || ''), completionKind,
      failureKind,
      label: failureKind ? '挤不进去...' : completionKind !== 'success' ? (record.source === 'configured-pricing-estimate' ? '本轮消耗（估算）:' : record.source === 'token-only' ? '本轮 token 用量:' : '本轮已观测消耗:') : String(record.label || '上一轮期间 API 扣费:'),
      amount: known ? Number(record.amount) : null,
      currency: record.currency || nativeCurrency,
      costState: known ? record.costState || 'observed' : record.costState === 'pending' ? 'pending' : 'unknown',
      tokens: Number.isFinite(record.tokens) && record.tokens >= 0 ? Math.floor(record.tokens) : null,
      quotaDelta: record.quotaDelta?.state==='observed' && Number.isFinite(record.quotaDelta.percent) && record.quotaDelta.percent>=0 ? Object.freeze({state:'observed',percent:record.quotaDelta.percent}) : Object.freeze({state:'unknown',percent:null}),
      note: String(record.note || ''),
    });
  }
  function enabled(notice, settings, turnCostOn) {
    return notice.completionKind === 'failed' && notice.failureKind === 'high-demand' || ['success','cancelled','failed'].includes(notice.completionKind) && !!turnCostOn;
  }
  function subscriptionSnapshot(record, nativeCurrency = 'USD') {
    const notice = snapshot(record, nativeCurrency);
    return Object.freeze({ ...notice, displayMode: 'subscription', amount: null,
      label: '上一轮对话消耗：',
      note: '本机已观测' + (notice.note ? ' · ' + notice.note : ''),
    });
  }
  function templateTokens(text, notice) {
    const value = notice?.tokens;
    const tokens = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value).toLocaleString('en-US') : '用量未知';
    return String(text || '').replace(/\{tokens\}/g, tokens);
  }
  function quotaText(notice) {
    const value=notice?.quotaDelta?.percent;
    return notice?.quotaDelta?.state==='observed'&&typeof value==='number'&&Number.isFinite(value)&&value>=0?Number(value.toFixed(3))+'%':'额度变化未知';
  }
  return Object.freeze({ kind, shouldNotify, snapshot, subscriptionSnapshot, templateTokens, quotaText, enabled });
});
