import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const widget = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8');
const preferences = fs.readFileSync(new URL('../desktop/ui/preferences-v3.js', import.meta.url), 'utf8');
const select = (start, end) => {
  const first = widget.indexOf(start), last = widget.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'actual widget audio function boundaries must exist');
  return widget.slice(first, last);
};
const eventNames = ['press', 'release', 'success', 'cancelled', 'failed'];
const oldStock = () => ({ feel: 'balanced', events: Object.fromEntries(eventNames.map(name => [name, { preset: ['press', 'release', 'success'].includes(name) ? 'original' : 'silent', volume: .8 }])) });
const explicitSuccess = () => ({ version: 2, feel: 'balanced', events: { success: { preset: 'original', volume: .35, volumeSet: true } } });

function fixture({ saved = null, group = { id: 'duck', press: 'ya1', release: 'ya2' } } = {}) {
  const sounds = [], warms = [], procedural = [], stops = [], timers = new Map();
  let timerId = 0;
  const window = {
    WhaleReferenceAudio: {
      sound(url) {
        const audio = {
          src: url, volume: 1, duration: 1, currentTime: 0, onended: null,
          plays: 0, pauses: 0, scheduled: [],
          play() { this.plays++; return Promise.resolve(); },
          playAt(delay) { this.scheduled.push(delay); return Promise.resolve(); },
          pause() { this.pauses++; },
          end() { this.onended?.(); },
        };
        sounds.push(audio); return audio;
      },
      warm(urls) { warms.push([...urls]); return Promise.resolve([]); },
      markPreview() {}, stopPreview() {},
    },
    WhaleAudio: { play(options) { procedural.push(options); }, stop(channel) { stops.push(channel); } },
  };
  const context = vm.createContext({
    window, localStorage: { getItem: () => saved ? JSON.stringify(saved) : null },
    soundOn: true, soundVol: .9, soundSet: group.id, audioGroups: [group],
    usageSet: { taskEnd: { on: true, sel: 'frag:end_a' } }, taskEndSel: { value: 'frag:end_a' },
    body: { style: {} },
    audioGroupSlotEmpty(id, slot) { return context.audioGroups.find(item => item.id === id)?.[slot] === ''; },
    clearTimeout(id) { timers.delete(id); },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  });
  vm.runInContext(preferences, context);
  vm.runInContext(select('    function soundVolumeOf(kind)', '    var bubbleToggle ='), context);
  vm.runInContext(select("    var SQUISH = 'scaleY(0.88) scaleX(1.05)';", '    var menuOpen = false;'), context);
  context.applySoundSet();
  return { context, feedback: window.WhaleFeedback, sounds, warms, procedural, stops, timers, get press() { return context.pressAudio; }, get release() { return context.releaseAudio; } };
}

test('default original gesture warms exactly the same fragment URLs that it plays at 90 percent', () => {
  const f = fixture();
  assert.deepEqual(f.warms[0], [f.press.src, f.release.src]);
  assert.match(f.press.src, /audio-fragment\.wav\?id=ya1$/); assert.match(f.release.src, /audio-fragment\.wav\?id=ya2$/);
  assert.equal(f.press.volume, .9); assert.equal(f.release.volume, .9);
  assert.match(f.press._alt, /sound\/press\.mp3\?set=duck$/);
  f.context.pressDown(); assert.equal(f.press.plays, 1); assert.equal(f.procedural.length, 0);
});

test('quick pointer release preserves the press and schedules release 40 milliseconds before its end', () => {
  const f = fixture(); f.context.pressDown(); f.press.currentTime = .12;
  const pausesBefore = f.press.pauses; f.context.pressUp();
  assert.equal(f.press.pauses, pausesBefore, 'pointerup does not truncate the original press');
  assert.equal(f.press.plays, 1); assert.equal(f.release.plays, 0);
  assert.ok(Math.abs(f.release.scheduled[0] - .84) < 1e-9);
  assert.equal(f.timers.size, 0, 'Web Audio playAt handles timing without a main-thread timer');
  f.press.end(); assert.equal(f.release.plays, 0, 'onended does not duplicate an already scheduled release');
});

test('a long hold waits for the user to release and then starts release immediately', () => {
  const f = fixture(); f.context.pressDown(); f.press.end();
  assert.equal(f.release.plays, 0); assert.equal(f.context.pressing, true);
  f.context.pressUp(); assert.equal(f.release.plays, 1); assert.equal(f.release.scheduled.length, 0);
});

test('a new pointerdown cancels the previous scheduled release and starts one new press', () => {
  const f = fixture(); f.context.pressDown(); f.press.currentTime = .1; f.context.pressUp();
  const pausesBefore = f.release.pauses;
  f.context.pressDown();
  assert.equal(f.release.pauses, pausesBefore + 1); assert.equal(f.press.plays, 2);
  assert.equal(f.context.releasePlayed, false);
  f.press.currentTime = .2; f.context.pressUp();
  assert.equal(f.release.scheduled.length, 2);
});

test('a silent press slot still permits release on every gesture', () => {
  const f = fixture({ group: { id: 'only-release', press: '', release: 'ya2' } });
  assert.equal(f.press, null);
  for (let i = 0; i < 3; i++) { f.context.pressDown(); f.context.pressUp(); }
  assert.equal(f.release.plays, 3); assert.equal(f.release.scheduled.length, 0);
});

test('a silent release slot preserves the complete press and emits no release', () => {
  const f = fixture({ group: { id: 'only-press', press: 'ya1', release: '' } });
  assert.equal(f.release, null); f.context.pressDown(); f.context.pressUp(); f.press.end();
  assert.equal(f.press.plays, 1); assert.equal(f.press.pauses, 0);
});

test('cold unknown duration uses press completion once as the release fallback', () => {
  const f = fixture(); f.press.duration = NaN;
  f.context.pressDown(); f.context.pressUp(); assert.equal(f.release.plays, 0);
  f.press.end(); f.press.end(); assert.equal(f.release.plays, 1);
});

test('completion sound groups play the whole press followed by release, with one release only', () => {
  const f = fixture(); f.context.usageSet.taskEnd.sel = 'grp:duck'; const count = f.sounds.length;
  f.context.playTaskEndSound(); const [press, release] = f.sounds.slice(count);
  assert.equal(press.plays, 1); assert.equal(release.plays, 0);
  assert.equal(press.volume, .9); assert.equal(release.volume, .9);
  assert.deepEqual(f.warms.at(-1), [press.src, release.src]);
  press.end(); press.end(); assert.equal(release.plays, 1); assert.equal(press.pauses, 0);
});

test('completion groups preserve either empty slot and an entirely silent group', () => {
  for (const [pressSlot, releaseSlot, expected] of [['', 'ya2', 'ya2'], ['ya1', '', 'ya1'], ['', '', null]]) {
    const f = fixture({ group: { id: 'custom', press: pressSlot, release: releaseSlot } });
    f.context.usageSet.taskEnd.sel = 'grp:custom'; const before = f.sounds.length; f.context.playTaskEndSound();
    const created = f.sounds.slice(before); assert.equal(created.length, expected ? 1 : 0);
    if (expected) { assert.ok(created[0].src.endsWith('id=' + expected)); assert.equal(created[0].plays, 1); }
  }
});

test('the default A plays at 90 percent and explicit completion volume is independent of gesture volume', () => {
  const stock = fixture(); stock.context.playTaskEndSound();
  assert.ok(stock.sounds.at(-1).src.endsWith('id=end_a')); assert.equal(stock.sounds.at(-1).volume, .9);
  const f = fixture({ saved: explicitSuccess() }); f.context.playTaskEndSound();
  assert.equal(f.sounds.at(-1).volume, .35); assert.equal(f.press.volume, .9); assert.equal(f.release.volume, .9);
  f.context.usageSet.taskEnd.sel = 'grp:duck'; const before = f.sounds.length; f.context.playTaskEndSound();
  assert.deepEqual(f.sounds.slice(before).map(sound => sound.volume), [.35, .35]);
});

test('sound off and zero master suppress gestures and completion even with an explicit event volume', () => {
  const f = fixture({ saved: explicitSuccess() }); f.context.soundVol = 0; f.context.soundOn = false;
  f.context.pressDown(); f.context.pressUp(); const before = f.sounds.length; f.context.playTaskEndSound();
  assert.equal(f.press.plays, 0); assert.equal(f.release.plays, 0); assert.equal(f.sounds.length, before);
  assert.equal(f.feedback.volume('success', 0), 0);
});

test('exact old default feedback is migrated to follow master volume instead of the old 0.8 multiplier', () => {
  const f = fixture({ saved: oldStock() });
  assert.equal(f.feedback.volume('press', .9), .9); assert.equal(f.feedback.volume('release', .9), .9);
  assert.equal(f.feedback.volume('success', .9), .9); assert.equal(f.feedback.volume('failed', .9), 0);
  assert.equal(f.feedback.volume('success', .45), .45);
});

test('customized legacy feedback is preserved while new volumeSet settings use an absolute event volume', () => {
  const legacy = oldStock(); legacy.events.press.preset = 'glass';
  const old = fixture({ saved: legacy }); assert.equal(old.feedback.usesOriginal('press'), false);
  assert.ok(Math.abs(old.feedback.volume('press', .9) - .72) < 1e-9, 'existing customized relative settings remain intact');
  const saved = { version: 2, feel: 'soft', events: { press: { preset: 'original', volume: .6, volumeSet: false }, success: { preset: 'original', volume: .35, volumeSet: true } } };
  const current = fixture({ saved }); assert.equal(current.feedback.feel, 'soft');
  assert.equal(current.feedback.volume('press', .9), .9); assert.equal(current.feedback.volume('press', .5), .5);
  assert.equal(current.feedback.volume('success', .9), .35); assert.equal(current.feedback.volume('success', .5), .35);
});
