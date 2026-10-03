import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createResetCreditsService } from '../runtime/reset-credits.mjs';

function makeConfig(dir, connection = {}) {
  let current = { id: 'openai', key: '', baseUrl: 'https://api.openai.com/v1', accountId: 'connection-a', ...connection };
  const config = { codexHome: dir, env: {}, resolve: () => current };
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'account-a', access_token: 'token-a' } }));
  return { config, setConnection(value) { current = { ...current, ...value }; }, setAuth(accountId, accessToken = `token-${accountId}`) {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: accountId, access_token: accessToken } }));
  } };
}

async function withConfig(t, connection) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reset-credits-test-'));
  const fixture = makeConfig(dir, connection);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return { dir, ...fixture };
}

const rpc = credits => ({ rateLimitResetCredits: credits });

test('availableCount is authoritative, including zero; null, missing, and invalid values remain unknown', async t => {
  const { config } = await withConfig(t);
  const values = [
    rpc({ availableCount: 0, credits: [{ id: 'one' }, { id: 'two' }] }),
    rpc({ availableCount: 3, credits: [{ id: 'only-row' }] }),
    rpc({ availableCount: null, credits: [{ id: 'rows-do-not-count' }] }),
    rpc({ credits: [{ id: 'rows-do-not-count' }] }),
    rpc({ availableCount: -1, credits: [{ id: 'bad' }] }),
    rpc({ availableCount: 1.5, credits: [{ id: 'bad' }] }),
    rpc(null),
    {},
    rpc({ availableCount: '7', credits: [] }),
    rpc({ availableCount: Number.MAX_SAFE_INTEGER + 1, credits: [] }),
  ];
  const service = createResetCreditsService(config, { readImpl: async () => values.shift() });
  t.after(() => service.close());
  const zero = await service.get();
  assert.deepEqual({ state: zero.state, availableCount: zero.availableCount }, { state: 'observed', availableCount: 0 });
  assert.equal(zero.source, 'official-app-server');
  assert.ok(Number.isSafeInteger(zero.observedAt));
  const three = await service.get({ force: true });
  assert.deepEqual({ state: three.state, availableCount: three.availableCount }, { state: 'observed', availableCount: 3 });
  for (let i = 0; i < 8; i++) {
    const result = await service.get({ force: true });
    assert.equal(result.state, 'unknown');
    assert.equal(result.availableCount, null);
  }
});

test('cache, force refresh, and concurrent calls are deduplicated per account', async t => {
  const { config } = await withConfig(t);
  let calls = 0;
  let release;
  const service = createResetCreditsService(config, { readImpl: async () => {
    calls++;
    if (calls === 2) await new Promise(resolve => { release = resolve; });
    return rpc({ availableCount: calls, credits: [] });
  } });
  t.after(() => service.close());
  assert.equal((await service.get()).availableCount, 1);
  assert.equal((await service.get()).availableCount, 1);
  const first = service.get({ force: true });
  const second = service.get({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  release();
  assert.deepEqual(await Promise.all([first, second]).then(results => results.map(result => result.availableCount)), [2, 2]);
  assert.equal(calls, 2);
});

test('the default cache expires after exactly sixty seconds', async t => {
  const { config } = await withConfig(t);
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let calls = 0;
  const service = createResetCreditsService(config, { readImpl: async () => rpc({ availableCount: ++calls }) });
  t.after(() => service.close());
  assert.equal((await service.get()).availableCount, 1);
  t.mock.timers.setTime(159999);
  assert.equal((await service.get()).availableCount, 1);
  assert.equal(calls, 1);
  t.mock.timers.setTime(160000);
  assert.equal((await service.get()).availableCount, 2);
  assert.equal(calls, 2);
});

test('failed refresh replaces a previous count with unknown and strips reader error text', async t => {
  const { config } = await withConfig(t);
  let calls = 0;
  const service = createResetCreditsService(config, { readImpl: () => {
    if (++calls === 1) return rpc({ availableCount: 4 });
    throw new Error('SENSITIVE_FAKE_ERROR_TEXT');
  } });
  t.after(() => service.close());
  assert.equal((await service.get()).availableCount, 4);
  const failed = await service.get({ force: true });
  assert.equal(failed.availableCount, null);
  assert.equal(failed.observedAt, null);
  assert.equal(failed.state, 'unknown');
  assert.equal(failed.source, 'official-app-server');
  assert.ok(typeof failed.reason === 'string' && failed.reason.length > 0);
  assert.doesNotMatch(JSON.stringify(failed), /SENSITIVE|token-|account-a/);
  assert.equal((await service.get()).availableCount, null);
  assert.equal(calls, 2);
});

test('account changes invalidate cache and cancel the previous request', async t => {
  const { config, setAuth } = await withConfig(t);
  let calls = 0;
  const service = createResetCreditsService(config, { readImpl: ({ signal }) => {
    calls++;
    if (calls === 1) return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return Promise.resolve(rpc({ availableCount: 9, credits: [] }));
  } });
  t.after(() => service.close());
  const first = service.get();
  await new Promise(resolve => setImmediate(resolve));
  setAuth('account-b');
  const second = await service.get();
  assert.equal(second.state, 'observed');
  assert.equal(second.availableCount, 9);
  const cancelled = await first;
  assert.equal(cancelled.state, 'unknown');
  assert.equal(calls, 2);
});

test('a completed read is discarded if auth changes without a second get call', async t => {
  const { config, setAuth } = await withConfig(t);
  let release;
  let calls = 0;
  const service = createResetCreditsService(config, { readImpl: async () => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return rpc({ availableCount: calls === 1 ? 123 : 6 });
  } });
  t.after(() => service.close());
  const old = service.get();
  await new Promise(resolve => setImmediate(resolve));
  setAuth('account-b');
  release();
  assert.equal((await old).availableCount, null);
  assert.equal((await service.get()).availableCount, 6);
  assert.equal(calls, 2);
});

test('changing the connection identity invalidates a cached subscription count', async t => {
  const { config, setConnection } = await withConfig(t);
  let calls = 0;
  const service = createResetCreditsService(config, { readImpl: async ({ identity }) => {
    assert.match(identity, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(identity, /account-a|token-a/);
    return rpc({ availableCount: ++calls });
  } });
  t.after(() => service.close());
  assert.equal((await service.get()).availableCount, 1);
  setConnection({ accountId: 'connection-b' });
  assert.equal((await service.get()).availableCount, 2);
});

test('API keys, relay endpoints, and incomplete subscription auth never invoke a reader', async t => {
  const { config, setAuth, setConnection } = await withConfig(t);
  let calls = 0;
  const service = createResetCreditsService(config, { readImpl: async () => { calls++; return rpc({ availableCount: 99 }); } });
  t.after(() => service.close());
  setConnection({ key: 'api-key' });
  assert.equal((await service.get()).state, 'unknown');
  setConnection({ key: '', baseUrl: 'https://relay.example.test/v1' });
  assert.equal((await service.get({ force: true })).state, 'unknown');
  setConnection({ baseUrl: 'https://api.openai.com/v1' });
  setAuth('');
  assert.equal((await service.get({ force: true })).state, 'unknown');
  assert.equal(calls, 0);
});

test('mixed API-key auth and explicit API auth cannot start an official subprocess', async t => {
  const { config, dir } = await withConfig(t);
  let starts = 0;
  let reads = 0;
  config.codexExecutable = process.execPath;
  const service = createResetCreditsService(config, { spawnImpl: () => { starts++; throw new Error('must-not-start'); } });
  const injected = createResetCreditsService(config, { readImpl: async () => { reads++; return rpc({ availableCount: 5 }); } });
  t.after(async () => { await service.close(); await injected.close(); });
  for (const extra of [{ OPENAI_API_KEY: 'mixed-fake-key' }, { auth_mode: 'apikey' }]) {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', tokens: { account_id: 'account-a', access_token: 'token-a' }, ...extra,
    }));
    assert.equal((await service.get({ force: true })).availableCount, null);
    assert.equal((await injected.get({ force: true })).availableCount, null);
  }
  assert.equal(starts, 0);
  assert.equal(reads, 0);
});

test('leaving subscription mode clears cached counts and aborts an outstanding read', async t => {
  const { config, setConnection } = await withConfig(t);
  let release;
  let signal;
  let calls = 0;
  const service = createResetCreditsService(config, { readImpl: async options => {
    signal = options.signal;
    calls++;
    if (calls === 1) return rpc({ availableCount: 5 });
    return new Promise(resolve => { release = resolve; });
  } });
  t.after(() => service.close());
  assert.equal((await service.get()).availableCount, 5);
  const forced = service.get({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  setConnection({ key: 'api-key' });
  assert.equal((await service.get()).availableCount, null);
  assert.equal(signal.aborted, true);
  release(rpc({ availableCount: 50 }));
  assert.equal((await forced).availableCount, null);
  setConnection({ key: '' });
  release = null;
  const subscription = service.get();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  release(rpc({ availableCount: 7 }));
  assert.equal((await subscription).availableCount, 7);
});

test('reader failures and timeouts never fabricate zero; close is idempotent', async t => {
  const { config } = await withConfig(t);
  let calls = 0;
  const service = createResetCreditsService(config, {
    timeoutMs: 20,
    readImpl: async ({ signal }) => {
      calls++;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      throw new Error('unreachable');
    },
  });
  const result = await service.get();
  assert.equal(result.state, 'unknown');
  assert.equal(result.availableCount, null);
  assert.equal(result.reason, 'request-timeout');
  assert.equal(calls, 1);
  await service.close();
  await service.close();
  assert.equal((await service.get()).state, 'unknown');
});

test('real stdio app-server protocol uses external tokens and reads only rate-limit credits', async t => {
  const { config, dir } = await withConfig(t);
  const script = path.join(dir, 'fake-app-server.mjs');
  const log = path.join(dir, 'rpc-log.json');
  await fsp.writeFile(script, `import fs from 'node:fs';\nimport readline from 'node:readline';\nconst methods=[];\nlet loginValid=false,initializeValid=false;\nconst rl=readline.createInterface({input:process.stdin});\nrl.on('line',line=>{ let p; try { p=JSON.parse(line); } catch { return; } if (p.method) methods.push(p.method); if(p.method==='initialize')initializeValid=p.params?.capabilities?.experimentalApi===true;if(p.method==='account/login/start')loginValid=p.params?.type==='chatgptAuthTokens'&&p.params?.accessToken==='token-a'&&p.params?.chatgptAccountId==='account-a';fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({methods,pid:process.pid,home:process.env.CODEX_HOME,loginValid,initializeValid,copiedAuth:fs.existsSync(process.env.CODEX_HOME+'/auth.json')})); if (p.id === undefined) return; let result={}; if(p.method === 'account/rateLimits/read') result={rateLimitResetCredits:{availableCount:7,credits:[{id:'one'}]}}; process.stdout.write(JSON.stringify({id:p.id,result})+'\\n'); });\n`);
  config.codexExecutable = process.execPath;
  const service = createResetCreditsService(config, {
    spawnImpl: (_binary, _args, options) => spawn(process.execPath, [script], options),
  });
  t.after(() => service.close());
  const result = await service.get({ force: true });
  assert.equal(result.state, 'observed');
  assert.equal(result.availableCount, 7);
  const recorded = JSON.parse(await fsp.readFile(log, 'utf8'));
  assert.deepEqual(recorded.methods, ['initialize', 'initialized', 'account/login/start', 'account/rateLimits/read']);
  assert.equal(recorded.loginValid, true);
  assert.equal(recorded.initializeValid, true);
  assert.equal(recorded.copiedAuth, false);
  assert.notEqual(recorded.home, dir);
  assert.equal(fs.existsSync(recorded.home), false);
  assert.throws(() => process.kill(recorded.pid, 0));
});

async function fakeProcess(t, mode, timeoutMs = 2000) {
  const { config, dir } = await withConfig(t);
  const script = path.join(dir, 'failure-app-server.mjs');
  const log = path.join(dir, 'process-state.json');
  const originalAuth = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  await fsp.writeFile(script, `
import fs from 'node:fs';
import readline from 'node:readline';
const mode=${JSON.stringify(mode)}, log=${JSON.stringify(log)};
const methods=[];
setInterval(()=>{},1000);
const write=packet=>process.stdout.write(JSON.stringify(packet)+'\\n');
// Poll a complete line from an append-only journal, without replacing a file
// which the parent may currently have open on Windows.
const record=()=>fs.appendFileSync(log,JSON.stringify({pid:process.pid,home:process.env.CODEX_HOME,methods,copiedAuth:fs.existsSync(process.env.CODEX_HOME+'/auth.json')})+'\\n');
record();
readline.createInterface({input:process.stdin}).on('line',line=>{
  let p;try{p=JSON.parse(line);}catch{return;}
  if(p.method){methods.push(p.method);record();}
  if(p.id===undefined||!p.method)return;
  if(p.method!=='account/rateLimits/read'){write({id:p.id,result:{}});return;}
  if(mode==='rpc-error'){write({id:p.id,error:{code:-1,message:'SENSITIVE_FAKE_SERVER_ERROR'}});return;}
  if(mode==='exit'){process.exit(17);return;}
  if(mode==='oversized'){process.stdout.write('x'.repeat(9*1024*1024));return;}
  if(mode==='refresh'){write({id:'refresh-1',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized'}});return;}
});
`);
  config.codexExecutable = process.execPath;
  const service = createResetCreditsService(config, {
    timeoutMs,
    spawnImpl: (_binary, _args, options) => {
      assert.equal(options.windowsHide, true);
      assert.notEqual(options.env.CODEX_HOME, dir);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      return spawn(process.execPath, [script], options);
    },
  });
  t.after(() => service.close());
  async function state() { const line=(await fsp.readFile(log, 'utf8')).split('\n').slice(0,-1).filter(Boolean).at(-1); return line ? JSON.parse(line) : null; }
  function assertCleaned(recorded) {
    assert.equal(recorded.copiedAuth, false);
    assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), originalAuth);
    assert.equal(fs.existsSync(recorded.home), false);
    assert.throws(() => process.kill(recorded.pid, 0));
  }
  return { service, state, assertCleaned, log };
}

test('RPC errors, early exit, oversized output, and external-token refresh leave no child or auth changes', async t => {
  for (const mode of ['rpc-error', 'exit', 'oversized', 'refresh']) await t.test(mode, async t => {
    const fixture = await fakeProcess(t, mode);
    const result = await fixture.service.get();
    assert.equal(result.availableCount, null);
    assert.equal(result.state, 'unknown');
    assert.equal(result.observedAt, null);
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|token-|account-a/);
    const recorded = await fixture.state();
    assert.deepEqual(recorded.methods, ['initialize', 'initialized', 'account/login/start', 'account/rateLimits/read']);
    fixture.assertCleaned(recorded);
  });
});

test('closing during a real subprocess read terminates the process and removes the isolated home', async t => {
  const fixture = await fakeProcess(t, 'wait', 10000);
  const reading = fixture.service.get();
  let recorded;
  // Allow cold subprocess startup under suite load; cancel only once the read
  // is actually pending, well before this fixture's request timeout.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(fixture.log)) {
      recorded = await fixture.state();
      if (recorded?.methods.includes('account/rateLimits/read')) break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(recorded?.methods.includes('account/rateLimits/read'));
  await fixture.service.close();
  assert.equal((await reading).availableCount, null);
  await fixture.service.close();
  fixture.assertCleaned(recorded);
});

test('a real subprocess timeout terminates the process and leaves count unknown', async t => {
  const fixture = await fakeProcess(t, 'wait', 1500);
  const result = await fixture.service.get();
  assert.equal(result.availableCount, null);
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'request-timeout');
  fixture.assertCleaned(await fixture.state());
});
