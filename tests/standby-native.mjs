import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { ROOT, DATA_HOME } from '../runtime/paths.mjs';
import { bridgeRequest } from '../runtime/bridge.mjs';
import { ensureService, stopService } from '../runtime/process.mjs';

if (process.platform !== 'win32') throw new Error('This isolated native regression requires Windows.');
const output = path.resolve(process.argv[2] || path.join(ROOT, '..', 'qa', 'standby-native'));
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, 'data-'));
const nativeDir = path.join(data, 'fixture-native');
fs.mkdirSync(nativeDir);
const electron = path.join(DATA_HOME, 'desktop-runtime', 'node_modules', 'electron', 'dist', 'electron.exe');
assert.ok(fs.existsSync(electron), 'Install the isolated desktop runtime first.');
const shell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return JSON.parse(fs.readFileSync(path.join(data, file), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const pidFile = path.join(data, 'standby-host-pid.txt');
const hosts = [], states = [];
let errors = '', supervisor, companionPid;

// Use the production supervisor verbatim. Replace only Codex discovery in its
// copied native API with a PID written by this harness. No real app is scanned.
for (const name of ['supervisor.ps1', 'WindowDiagnostics.cs', 'WindowStacking.cs']) {
  fs.copyFileSync(path.join(ROOT, 'desktop', name), path.join(nativeDir, name));
}
let nativeSource = fs.readFileSync(path.join(ROOT, 'desktop', 'WindowApi.cs'), 'utf8');
const rootsStart = nativeSource.indexOf('    static int[] Roots() {');
const rootsEnd = nativeSource.indexOf('    static IntPtr lastWindow', rootsStart);
assert.ok(rootsStart >= 0 && rootsEnd > rootsStart);
nativeSource = nativeSource.slice(0, rootsStart) + `    static int[] Roots() {
        try {
            int pid; if (!int.TryParse(File.ReadAllText(Environment.GetEnvironmentVariable("WHALE_STANDBY_PID_FILE")).Trim(), out pid) || pid <= 0) return new int[0];
            using (var process = Process.GetProcessById(pid)) {
                if (process.HasExited || !Image(pid).EndsWith(@"\\electron\\dist\\electron.exe", StringComparison.OrdinalIgnoreCase)) return new int[0];
            }
            return new int[] { pid };
        } catch { return new int[0]; }
    }
` + nativeSource.slice(rootsEnd);
nativeSource = nativeSource.replace(/static bool CodexImage\(string p\) \{[^\r\n]+\}/, 'static bool CodexImage(string p) { return p.EndsWith(@"\\electron\\dist\\electron.exe", StringComparison.OrdinalIgnoreCase); }');
nativeSource = nativeSource.replace('(GetWindowLongPtr(h, -20).ToInt64() & 0x80) == 0', 'true');
// The harmless fixture uses skipTaskbar, so Electron gives it a hidden owner.
nativeSource = nativeSource.replace('GetWindow(h, 4) == IntPtr.Zero && IsWindowVisible(h)', 'IsWindowVisible(h)');
fs.writeFileSync(path.join(nativeDir, 'WindowApi.cs'), nativeSource);
fs.writeFileSync(pidFile, '0');
fs.writeFileSync(path.join(data, 'follow-config.json'), JSON.stringify({ enabled: true, mode: 'follow-codex', electronPath: electron, pluginRoot: ROOT }));
const env = { ...process.env, WHALE_DESKTOP_TEST: '1', WHALE_STANDBY_TEST: '1', WHALE_STANDBY_PID_FILE: pidFile, WHALE_HOME: data, GPT_WIDGET_HOME: data };
for (const name of ['ELECTRON_RUN_AS_NODE', 'WHALE_GPT_PREVIEW', 'WHALE_DESKTOP_AUDIT', 'WHALE_VISIBILITY_STRESS']) delete env[name];
const status = () => bridgeRequest('/api/status', { dataDir: data, timeoutMs: 1200 });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function wait(fn, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch {} await delay(120); }
  throw new Error('Timed out: ' + label + '; ' + errors + '; ' + JSON.stringify(read('supervisor-error.json')) + '; ' + JSON.stringify(read('desktop-error.json')));
}
function saveState(label, state) { states.push({ label, ...state }); }
async function startHost() {
  const child = spawn(electron, [path.join(ROOT, 'tests', 'visibility-stress-host.cjs'), '--fixture-dir=' + data], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', b => { errors = (errors + b).slice(-2500); });
  hosts.push(child);
  const lines = createInterface({ input: child.stdout });
  const ready = await wait(async () => {
    const line = await Promise.race([once(lines, 'line').then(([line]) => line), delay(15000).then(() => null)]);
    if (!line) return null;
    try { const parsed = JSON.parse(line); return parsed.ready && parsed; } catch { return null; }
  }, 'isolated host window');
  fs.writeFileSync(pidFile, String(ready.pid));
  return { child, ready };
}
async function closeHost(host) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(host.ready.pipe);
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Fixture close timeout')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'close', command: 'close' }) + '\n'));
    socket.on('data', () => { socket.destroy(); resolve(); });
  });
  await wait(() => host.child.exitCode !== null, 'isolated host exit');
  fs.writeFileSync(pidFile, '0');
}

try {
  supervisor = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(nativeDir, 'supervisor.ps1'), '-DataDir', data], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  supervisor.stderr.on('data', b => { errors = (errors + b).slice(-2500); });
  const waiting = await wait(async () => { const s = await status(); return s.rendererReady && s.waitingForCodex && !s.visible && s; }, 'ready without Codex', 35000);
  companionPid = read('runtime.json').pid;
  assert.equal((await ensureService({ dataDir: data })).ok, true, 'A waiting service counts as ready.');
  assert.equal(waiting.connectionNotifications.length, 1);
  assert.equal(waiting.connectionNotifications[0].content, '未连接 Codex，等待启动');
  saveState('startup-hidden-waiting', waiting);
  for (let i = 0; i < 6; i++) { await delay(180); assert.equal((await status()).connectionNotifications.length, 1); }
  await bridgeRequest('/api/desktop-mode', { dataDir: data, method: 'POST', body: { mode: 'standalone' } });
  const desktop = await wait(async () => { const s = await status(); return s.desktopMode === 'standalone' && s.visible && !s.nativeFollowing && s; }, 'standalone keeps its existing no-Codex interaction');
  saveState('standalone-visible-without-host', desktop);
  await bridgeRequest('/api/desktop-mode', { dataDir: data, method: 'POST', body: { mode: 'follow-codex' } });
  await wait(async () => { const s = await status(); return s.waitingForCodex && !s.visible && s.connectionNotifications.length === 1; }, 'return to hidden follow mode');
  const first = await startHost();
  const following = await wait(async () => { const s = await status(); return s.rendererReady && s.hostPid === first.ready.pid && s.visible && s.nativeFollowing && s.hostWindow === first.ready.handle && s; }, 'attach first isolated host');
  assert.equal(read('runtime.json').pid, companionPid);
  assert.equal(read('follow-state.json').state.attached, true);
  saveState('first-host-following', following);
  await closeHost(first);
  const closed = await wait(async () => { const s = await status(); return s.rendererReady && s.waitingForCodex && !s.visible && !s.nativeFollowing && s.hostWindow === '0' && s; }, 'owner close returns to hidden waiting');
  assert.equal(read('runtime.json').pid, companionPid);
  assert.equal(alive(companionPid), true);
  assert.equal(alive(supervisor.pid), true);
  assert.equal(closed.connectionNotifications.length, 1);
  saveState('first-host-closed-hidden', closed);

  // Deterministically exercise the fallback for Windows destroying an owned
  // HWND before the poll sees its owner exit, regardless of OS timing today.
  const beforeRebuild = closed.windowRecreations;
  fs.writeFileSync(path.join(data, 'standby-force-destroy.request'), 'fixture-only');
  const rebuilt = await wait(async () => { const s = await status(); return s.windowRecreations === beforeRebuild + 1 && s.rendererReady && !s.visible && s.waitingForCodex && s; }, 'hidden HWND recreation');
  assert.equal(read('runtime.json').pid, companionPid);
  assert.equal(rebuilt.connectionNotifications.length, 1);
  saveState('forced-owned-window-rebuilt-hidden', rebuilt);
  const second = await startHost();
  assert.notEqual(first.ready.pid, second.ready.pid);
  const reopened = await wait(async () => { const s = await status(); return s.rendererReady && s.hostPid === second.ready.pid && s.hostWindow === second.ready.handle && s.visible && s.nativeFollowing && s; }, 'attach reopened isolated host');
  assert.equal(read('runtime.json').pid, companionPid);
  saveState('second-host-following', reopened);
  await closeHost(second);
  await wait(async () => { const s = await status(); return s.waitingForCodex && !s.visible && s; }, 'second host close');
  const controlResult = await exec(process.execPath, [path.join(ROOT, 'scripts', 'control.mjs'), 'stop'], { env, windowsHide: true, timeout: 30000 });
  const stopped = JSON.parse(controlResult.stdout);
  assert.deepEqual(stopped, { ok: true, stopped: true });
  assert.equal(alive(companionPid), false);
  assert.equal(alive(supervisor.pid), false);
  assert.equal(read('pause-until-host-exit.json').pauseAll, true);
  const afterStop = await startHost();
  await delay(1800);
  assert.equal(fs.existsSync(path.join(data, 'runtime.json')), false, 'Opening a host after explicit stop cannot revive the widget.');
  assert.equal(alive(companionPid), false);
  assert.equal(alive(supervisor.pid), false);
  await closeHost(afterStop);
  assert.deepEqual(await stopService({ dataDir: data }), { ok: true, stopped: true }, 'Stop is idempotent.');
  const firstSupervisorPid = supervisor.pid;
  // No IPC may exist yet when a user stops the widget. Hold one isolated child
  // before ready, so the supervisor must use its bounded shutdown fallback.
  const notReadyRoot = path.join(data, 'not-ready-root');
  fs.mkdirSync(path.join(notReadyRoot, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(notReadyRoot, 'desktop', 'main.cjs'), `const {app}=require('electron');const fs=require('fs'),path=require('path');const dir=process.argv.find(x=>x.startsWith('--whale-data=')).slice(13);app.setPath('userData',path.join(dir,'not-ready-profile'));app.whenReady().then(()=>fs.writeFileSync(path.join(dir,'not-ready-child.json'),JSON.stringify({pid:process.pid})));setInterval(()=>{},1000);app.on('window-all-closed',()=>{});`);
  fs.writeFileSync(path.join(data, 'follow-config.json'), JSON.stringify({ enabled: true, mode: 'follow-codex', electronPath: electron, pluginRoot: notReadyRoot }));
  fs.unlinkSync(path.join(data, 'pause-until-host-exit.json'));
  supervisor = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(nativeDir, 'supervisor.ps1'), '-DataDir', data], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  supervisor.stderr.on('data', b => { errors = (errors + b).slice(-2500); });
  const unready = await wait(() => read('not-ready-child.json'), 'child waiting before IPC readiness');
  assert.equal(fs.existsSync(path.join(data, 'runtime.json')), false);
  assert.equal(alive(unready.pid), true);
  const earlyStop = await exec(process.execPath, [path.join(ROOT, 'scripts', 'control.mjs'), 'stop'], { env, windowsHide: true, timeout: 30000 });
  assert.deepEqual(JSON.parse(earlyStop.stdout), { ok: true, stopped: true });
  assert.equal(alive(supervisor.pid), false);
  assert.equal(alive(unready.pid), false, 'The exact never-ready child is stopped after the shutdown timeout.');
  const report = { ok: true, companionPid, supervisorPid: firstSupervisorPid, states, explicitStopTerminatedBoth: true, noRevivalAfterHostReopen: true, stopBeforeReadyTerminatedBoth: true, realCodexTouched: false };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, states: states.map(s => s.label), explicitStopTerminatedBoth: true, noRevivalAfterHostReopen: true, stopBeforeReadyTerminatedBoth: true, result: path.join(output, 'result.json') }));
} catch (error) {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: error.message, states, errors, data }, null, 2));
  throw error;
} finally {
  await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'desktop', 'supervisor.ps1'), '-DataDir', data, '-Stop'], { env, windowsHide: true }).catch(() => {});
  for (const host of hosts) if (host.exitCode === null) host.kill();
  if (supervisor?.exitCode === null) {
    await wait(() => supervisor.exitCode !== null, 'fixture supervisor cleanup', 12000).catch(() => supervisor.kill());
  }
  if (companionPid && alive(companionPid)) { try { process.kill(companionPid); } catch {} }
}
