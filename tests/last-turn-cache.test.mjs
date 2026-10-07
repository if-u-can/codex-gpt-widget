import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhaleService } from '../runtime/service.mjs';
import { ConfigStore } from '../runtime/config.mjs';
import { writeJson } from '../runtime/paths.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-last-turn-'));
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model="codex"\n');
  const config = new ConfigStore({ dataDir: dir, codexHome: dir, env: {} });
  const service = new WhaleService({ config });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, file: path.join(dir, 'last-turn.json') };
}

test('lastTurn serves a cached snapshot but reflects external edits', t => {
  const { service, file } = fixture(t);
  writeJson(file, { ok: true, seq: 1, turn: 'a', amount: 0.01, tokens: 10, ts: 1 });
  const first = service.lastTurn();
  assert.equal(first.seq, 1);
  assert.equal(first.turn, 'a');
  // The 1 Hz poll re-reads this file; unchanged content must serve the cache.
  assert.deepEqual(service.lastTurn(), first);
  // A different byte length guarantees a different stamp despite mtime granularity.
  writeJson(file, { ok: true, seq: 2, turn: 'bb', amount: 0.02, tokens: 20, ts: 2 });
  assert.equal(service.lastTurn().seq, 2);
  assert.equal(service.lastTurn().turn, 'bb');
});

test('lastTurn hides snapshots bound to another account or quota identity', t => {
  const { service, file } = fixture(t);
  writeJson(file, { ok: true, seq: 5, accountId: 'someone-else', turn: 'x', amount: 0.01, tokens: 1, ts: 1 });
  assert.deepEqual(service.lastTurn(), { ok: true, seq: 5, turn: null, amount: null, tokens: null, ts: null });

  // A quota reading must name the quota identity it was measured against.
  writeJson(file, { ok: true, seq: 6, quotaDelta: 0.02, turn: 'y', amount: 0.02, tokens: 2, ts: 2 });
  assert.equal(service.lastTurn().turn, null);

  writeJson(file, { ok: true, seq: 7, quotaAccountId: 'not-the-current-quota', turn: 'z', amount: 0.03, tokens: 3, ts: 3 });
  assert.equal(service.lastTurn().turn, null);
});
