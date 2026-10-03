import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSubscriptionAccount } from './account-mode.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);

// The API connection hash does not distinguish ChatGPT accounts without API
// keys. Only an opaque hash of the local subscription identity is retained.
export function subscriptionQuotaContext(config, connection = null) {
  try {
    const current = connection || config.resolve(), file = path.join(config.codexHome, 'auth.json');
    if (fs.statSync(file).size >= 1024 * 1024) return { subscription: false, identity: null };
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isSubscriptionAccount(current, auth)) return { subscription: false, identity: null };
    const account = auth.tokens?.account_id;
    return { subscription: true, identity: typeof account === 'string' && account.trim() ?
      createHash('sha256').update(String(current.accountId) + '\0' + account).digest('hex') : null };
  } catch { return { subscription: false, identity: null }; }
}

export async function readQuotaSample(config, reader, identity) {
  if (!identity || typeof reader !== 'function' || subscriptionQuotaContext(config).identity !== identity) return null;
  try {
    const data = await reader({ force: true }), sampledAt = Date.now();
    if (subscriptionQuotaContext(config).identity !== identity) return null;
    const sub = data?.subscription, windows = (sub?.windows || []).filter(w => w.windowDurationMins === 300);
    if (windows.length !== 1) return null;
    const window = windows[0], observedAt = window.observedAt ?? sub.observedAt;
    return { identity, observedAt, sampledAt, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
      valid: data.ok !== false && !data.error && sub.available === true && !sub.stale && !window.stale &&
        finite(observedAt) && observedAt <= sampledAt && sampledAt - observedAt <= 15 * 60000 &&
        finite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
        finite(window.resetsAt) && window.resetsAt > sampledAt };
  } catch { return null; }
}

export function quotaDelta(start, end, { complete = true } = {}) {
  const result = { percent: null, state: 'unknown',
    startObservedAt: finite(start?.observedAt) ? start.observedAt : null,
    endObservedAt: finite(end?.observedAt) ? end.observedAt : null };
  if (!complete || !start?.valid || !end?.valid || !start.identity || start.identity !== end.identity ||
      end.observedAt <= start.observedAt || end.sampledAt < start.sampledAt ||
      end.resetsAt !== start.resetsAt || end.resetsAt <= end.sampledAt ||
      end.usedPercent < start.usedPercent) return result;
  return { ...result, percent: Math.round((end.usedPercent - start.usedPercent) * 1e8) / 1e8, state: 'observed' };
}
