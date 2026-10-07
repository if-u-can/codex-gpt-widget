import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhaleService } from '../runtime/service.mjs';
import { ConfigStore } from '../runtime/config.mjs';

function fixture(t, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-cache-'));
  const config = new ConfigStore({ dataDir: dir, codexHome: dir, env });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { config, dir, env };
}

test('resolve caches by file stamps and reflects config.toml edits immediately', t => {
  const { config, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model="codex-mini"\n');
  const first = config.resolve();
  assert.equal(first.model, 'codex-mini');
  assert.equal(config.resolve(), first, 'unchanged inputs must serve the cached resolution');
  // A different length guarantees a different stamp regardless of mtime granularity.
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model="codex-mini-next"\n');
  assert.equal(config.resolve().model, 'codex-mini-next');
});

test('resolve reflects environment variable changes tracked in its dependency set', t => {
  const { config, dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://relay.example/v1"\nenv_key="RELAY_KEY"\n');
  env.RELAY_KEY = 'sk-first-key-aaaaaaaa';
  const first = config.resolve();
  assert.equal(first.keySource, 'environment');
  assert.notEqual(config.resolve().accountId, undefined);
  env.RELAY_KEY = 'sk-second-key-bbbbbbb';
  const second = config.resolve();
  assert.equal(second.key, 'sk-second-key-bbbbbbb', 'provider env_key value changes must invalidate');
  assert.notEqual(second.accountId, first.accountId);
  env.OPENAI_BASE_URL = 'https://override.example/v1';
  assert.notEqual(config.resolve(), second, 'OPENAI_BASE_URL must invalidate even when provider.base_url shadows it');
});

test('OPENAI_API_KEY fallback participates in the invalidation key', t => {
  const { config, dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model="codex"\n');
  env.OPENAI_API_KEY = 'sk-env-one-aaaaaaaa';
  const first = config.resolve();
  assert.equal(first.keySource, 'environment');
  env.OPENAI_API_KEY = 'sk-env-two-bbbbbbbb';
  const second = config.resolve();
  assert.equal(second.key, 'sk-env-two-bbbbbbbb');
  assert.notEqual(second.accountId, first.accountId);
});

test('save invalidates synchronously and auth.json edits change the resolved key', t => {
  const { config, dir } = fixture(t);
  config.save({ currency: 'USD' });
  assert.equal(config.resolve().setting.currency, 'USD');
  config.save({ currency: 'CNY' });
  assert.equal(config.resolve().setting.currency, 'CNY', 'same-tick saves must be visible without stat ambiguity');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-auth-one-aaaa' }));
  const first = config.resolve();
  assert.equal(first.keySource, 'codex-auth');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-auth-two-bbbbbb' }));
  const second = config.resolve();
  assert.equal(second.key, 'sk-auth-two-bbbbbb');
  assert.notEqual(second.accountId, first.accountId);
});

test('usage settings cache serves clones and reflects both external edits and writes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-usage-cache-'));
  const config = new ConfigStore({ dataDir: dir, codexHome: dir, env: {} });
  const service = new WhaleService({ config });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = service.readUsageSettings();
  first.alert.lines[0].text = '就地篡改';
  const second = service.readUsageSettings();
  assert.notEqual(second.alert.lines[0].text, '就地篡改', 'mutating a returned copy must not corrupt the cache');
  fs.writeFileSync(path.join(dir, 'usage-settings.json'), JSON.stringify({ budget: { amount: 6.25, note: 'external-edit-padding' } }));
  assert.equal(service.readUsageSettings().budget.amount, 6.25, 'external writes must invalidate by stamp');
  service.writeUsageSettings({ alert: { below: 1.5 } });
  assert.equal(service.readUsageSettings().alert.below, 1.5, 'writeUsageSettings must invalidate synchronously');
});
