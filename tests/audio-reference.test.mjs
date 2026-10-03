import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../desktop/ui/reference-audio.js', import.meta.url), 'utf8');
function fixture({ deferred = false, failPrimary = false } = {}) {
  const sources = [], gains = [], contexts = [], requests = [], timers = new Map(), listeners = new Map();
  let wall = 1000, timerId = 0, resolveFetch;
  const document = {
    hidden: false,
    addEventListener(name, fn) { const entries = listeners.get(name) || []; entries.push(fn); listeners.set(name, entries); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(entry => entry !== fn)); },
  };
  class AudioContext {
    state = 'running'; currentTime = 10; destination = {};
    constructor(options) { this.options = options; contexts.push(this); }
    resume() { this.state = 'running'; this.resumes = (this.resumes || 0) + 1; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; this.suspends = (this.suspends || 0) + 1; return Promise.resolve(); }
    close() { throw Error('Reference idle logic must not close its unlocked context'); }
    decodeAudioData() { this.decodes = (this.decodes || 0) + 1; return Promise.resolve({ duration: 1 }); }
    createGain() { const gain = { gain: { value: 0 }, connect() {}, disconnect() { this.disconnected = true; } }; gains.push(gain); return gain; }
    createBufferSource() {
      const node = { connect() {}, start(when, offset) { this.when = when; this.offset = offset; this.started = true; }, stop() { this.stopped = true; }, end() { this.onended?.(); } };
      sources.push(node); return node;
    }
  }
  const context = {
    window: { AudioContext, addEventListener() {} }, document,
    performance: { now: () => wall },
    fetch(url) {
      requests.push(url);
      const reply = { ok: !(failPrimary && url === '/primary'), arrayBuffer: async () => new ArrayBuffer(8) };
      if (deferred && !resolveFetch) return new Promise(resolve => { resolveFetch = () => resolve(reply); });
      return Promise.resolve(reply);
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(source, context);
  return {
    api: context.window.WhaleReferenceAudio, sources, gains, contexts, requests, document,
    advance(ms) { wall += ms; for (const c of contexts) c.currentTime += ms / 1000; },
    idle() { const current = [...timers.values()].at(-1); assert.equal(current.ms, 60000); current.fn(); },
    resolve() { resolveFetch?.(); },
    dispatch(name, event = {}) { for (const fn of [...(listeners.get(name) || [])]) fn(event); },
  };
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

test('predecoded sounds start in the current task and retain the exact requested volume', async () => {
  const f = fixture(); await f.api.warm(['/press']);
  const sound = f.api.sound('/press'); sound.volume = .9;
  const result = sound.play();
  assert.equal(f.sources.length, 1, 'start occurs before awaiting the returned promise');
  assert.equal(f.sources[0].started, true); assert.equal(f.gains[0].gain.value, .9);
  assert.equal(f.contexts[0].options.latencyHint, 'interactive');
  await result;
  sound.volume = .35; sound.currentTime = 0; sound.play();
  assert.equal(f.gains[1].gain.value, .35, 'explicit volume is not multiplied by an extra default coefficient');
});

test('playAt schedules on the audio clock and currentTime advances from actual playback', async () => {
  const f = fixture(); await f.api.warm(['/press', '/release']);
  const press = f.api.sound('/press'), release = f.api.sound('/release');
  press.play(); f.advance(120);
  assert.ok(Math.abs(press.currentTime - .12) < 1e-9);
  release.playAt(Math.max(0, press.duration - press.currentTime - .04));
  assert.ok(Math.abs(f.sources[1].when - 10.96) < 1e-9, 'quick release enters 40 ms before the 1-second press ends');
  assert.equal(f.sources[0].stopped, undefined, 'release must not cut off press');
  assert.equal(release.currentTime, 0, 'a scheduled sound has not progressed before its start');
  f.advance(900); assert.ok(Math.abs(release.currentTime - .06) < 1e-9);
});

test('independent sounds and previews preserve genuine event playback', async () => {
  const f = fixture(); await f.api.warm(['/press', '/completion']);
  const press = f.api.sound('/press'), completion = f.api.sound('/completion');
  press.play(); completion.play();
  assert.equal(f.sources[0].stopped, undefined);
  f.api.markPreview(true); const preview = f.api.sound('/press'); f.api.markPreview(false); preview.play();
  f.api.stopPreview();
  assert.equal(f.sources[2].stopped, true);
  assert.equal(f.sources[0].stopped, undefined); assert.equal(f.sources[1].stopped, undefined);
  f.api.stopAll(); assert.equal(f.sources[0].stopped, true); assert.equal(f.sources[1].stopped, true);
});

test('idle suspends without discarding cached decoding or creating another context', async () => {
  const f = fixture(); await f.api.warm(['/press']); const sound = f.api.sound('/press'); sound.play();
  f.sources[0].end(); f.idle();
  assert.equal(f.contexts[0].state, 'suspended'); assert.equal(f.contexts[0].decodes, 1);
  const result = sound.play();
  assert.equal(f.sources.length, 2, 'cached start remains synchronous after idle'); await result;
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].decodes, 1); assert.equal(f.requests.length, 1);
  assert.equal(f.contexts[0].state, 'running');
});

test('zero volume and the global off switch do not open audio hardware or fetch', async () => {
  const f = fixture(); const muted = f.api.sound('/press'); muted.volume = 0; await muted.play();
  assert.equal(f.contexts.length, 0); assert.equal(f.requests.length, 0);
  f.api.setEnabled(() => false); await f.api.warm(['/press']); await f.api.sound('/press').play();
  f.dispatch('pointerdown'); assert.equal(f.contexts.length, 0); assert.equal(f.requests.length, 0);
});

test('pause and stopAll invalidate pending decoding and scheduled playback', async () => {
  const f = fixture({ deferred: true }), sound = f.api.sound('/press');
  sound.play(); sound.pause(); f.resolve(); await settle(); assert.equal(f.sources.length, 0);
  await f.api.warm(['/press']); sound.playAt(.5); f.api.stopAll();
  assert.equal(f.sources[0].stopped, true);
  const g = fixture({ deferred: true }); g.api.sound('/press').play(); g.api.stopAll(); g.resolve(); await settle();
  assert.equal(g.sources.length, 0);
});

test('one failed route falls back once without duplicate playback', async () => {
  const f = fixture({ failPrimary: true }), sound = f.api.sound('/primary'); sound._alt = '/fallback';
  await sound.play(); await settle();
  assert.deepEqual(f.requests, ['/primary', '/fallback']); assert.equal(sound.src, '/fallback'); assert.equal(sound._alt, '');
  assert.equal(f.sources.length, 1); assert.equal(f.sources[0].started, true);
});

test('composition does not unlock audio and a hidden document suspends the unlocked context', () => {
  const f = fixture(); f.dispatch('compositionstart'); f.dispatch('keydown', {}); assert.equal(f.contexts.length, 0);
  f.dispatch('compositionend'); f.dispatch('keydown', { keyCode: 229 }); f.dispatch('keydown', { isComposing: true }); assert.equal(f.contexts.length, 0);
  f.dispatch('pointerdown'); assert.equal(f.contexts.length, 1);
  f.document.hidden = true; f.dispatch('visibilitychange'); assert.equal(f.contexts[0].state, 'suspended');
  f.document.hidden = false; f.dispatch('pointerdown'); assert.equal(f.contexts[0].state, 'suspended', 'unlock listeners remove themselves after a successful gesture');
});
