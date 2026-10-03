import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { createVisibilityController } = createRequire(import.meta.url)('../desktop/visibility.cjs');
const source = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const hostFunctions = source.slice(source.indexOf('async function setHost('), source.indexOf('async function importLegacyStorage('));
const quitFunctions = source.slice(source.indexOf('function pauseAndQuit('), source.indexOf('function isMainFrame('));

function fixture({ standalone = false } = {}) {
  let visible = false;
  const timers = [], calls = [], area = { x: 0, y: 0, width: 1000, height: 700 };
  const state = {
    path, dataDir: '/fixture', fixture: false, Number, Date,
    desktopMode: standalone ? 'standalone' : 'follow-codex', modePending: false,
    desktopBoundsApplied: false, manuallyHidden: false, quitting: false, rendererReady: true,
    usesWindowShape: true, isMac: false, hostSequence: -1, hostHeartbeat: 0,
    lastHost: null, owner: 'old-owner', appliedBounds: 'old-bounds', appliedNativeSize: 'old-size',
    keyboardFocus: true, inputEnabled: true, waitingNotificationShown: false, connectionNotifications: [],
    visibilityRecorder: { sample() {} },
    window: {
      isDestroyed: () => false, isVisible: () => visible,
      hide() { visible = false; calls.push('hide'); }, showInactive() { visible = true; calls.push('show'); },
      setIgnoreMouseEvents(ignored) { calls.push(['ignore-input', ignored]); },
      getBounds: () => area, setBounds() {}, setPosition() {}, setAlwaysOnTop() {}, webContents: { send() {} },
    },
    tray: { displayBalloon(notification) { calls.push(['notification', notification.content]); } },
    app: { quit() { calls.push('quit'); } },
    save(file, value) { calls.push(['save', path.basename(file), value]); },
    sendCursor() {}, sendWorkArea() {}, updateTray() {}, diagnose() {}, markStartup() {}, toDipRect: x => x,
    screen: { getPrimaryDisplay: () => ({ workArea: area }) },
    syncNativeViewport: () => 'new-size',
  };
  state.visibilityController = createVisibilityController({
    getWindow: () => state.window,
    getState: () => ({ ready: state.rendererReady, quitting: state.quitting, standalone: state.desktopMode === 'standalone', manuallyHidden: state.manuallyHidden, host: state.lastHost, fixture: true }),
    schedule: fn => { timers.push(fn); return fn; },
    cancel: fn => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
  });
  state.visibility = () => state.visibilityController.update();
  vm.createContext(state); vm.runInContext(quitFunctions + hostFunctions, state);
  return { state, calls, visible: () => visible, flush() { while (timers.length) timers.shift()(); },
    host: (patch = {}) => state.setHost({ hostAlive: true, hostPid: 11, window: '101', visible: true, attached: true, nativeFollowing: true, mode: state.desktopMode, bounds: area, ...patch }) };
}

test('no Codex starts hidden, emits one waiting notice, and repeated state/show cannot expose the window', async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) { await f.host({ serial: i, hostAlive: false }); f.state.visibilityController.requestRecovery(); f.flush(); }
  assert.equal(f.visible(), false);
  assert.equal(f.calls.filter(c => c[0] === 'notification').length, 1);
  assert.equal(f.calls.find(c => c[0] === 'notification')[1], '未连接 Codex，等待启动');
  assert.equal(f.calls.includes('quit'), false);
  assert.equal(f.state.inputEnabled, false);
  assert.equal(f.state.keyboardFocus, false);
  assert.equal(f.state.owner, '');
  assert.equal(f.state.appliedBounds, '');
  assert.equal(f.state.appliedNativeSize, '');
  assert.equal(f.state.lastHost.attached, false);
  assert.equal(f.state.lastHost.nativeFollowing, false);
  assert.equal(f.state.lastHost.window, '0');
});

test('open, close, and reopen follow new host PID without quitting or repeating the notice', async () => {
  const f = fixture();
  await f.host({ serial: 1, hostAlive: false });
  await f.host({ serial: 2 }); f.flush();
  assert.equal(f.visible(), true); assert.equal(f.state.owner, '101');
  await f.host({ serial: 3, hostAlive: false }); f.flush();
  assert.equal(f.visible(), false); assert.equal(f.state.owner, '');
  await f.host({ serial: 4, hostPid: 22, window: '202' }); f.flush();
  assert.equal(f.visible(), true); assert.equal(f.state.owner, '202');
  assert.equal(f.state.lastHost.hostPid, 22);
  assert.equal(f.calls.includes('quit'), false);
  assert.equal(f.calls.filter(c => c[0] === 'notification').length, 1);
});

test('a stale host packet cannot resurrect a closed connection', async () => {
  const f = fixture(); await f.host({ serial: 8 }); f.flush();
  await f.host({ serial: 10, hostAlive: false });
  await f.host({ serial: 9 }); f.flush();
  assert.equal(f.visible(), false); assert.equal(f.state.lastHost.hostAlive, false);
});

test('standalone preserves desktop visibility without Codex and emits no waiting notice', async () => {
  const f = fixture({ standalone: true });
  await f.host({ hostAlive: false, nativeFollowing: false, attached: false }); f.flush();
  assert.equal(f.visible(), true); assert.equal(f.calls.includes('quit'), false);
  assert.equal(f.calls.filter(c => c[0] === 'notification').length, 0);
});

test('explicit stop saves a permanent pause for either mode before quitting', () => {
  for (const standalone of [false, true]) {
    const f = fixture({ standalone }); f.state.pauseAndQuit();
    const saved = f.calls.find(c => c[0] === 'save');
    assert.equal(saved[1], 'pause-until-host-exit.json'); assert.equal(saved[2].pauseAll, true);
    assert.equal(f.calls.at(-1), 'quit');
  }
});

test('only a supervisor exit message asks Electron to quit; a host disappearance does not', async () => {
  const f = fixture(); await f.host({ hostAlive: false }); assert.equal(f.calls.includes('quit'), false);
  await f.host({ hostAlive: false, monitorExit: true }); assert.equal(f.calls.includes('quit'), true);
});
