import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_HOME, ROOT, readJson, writeJson } from './paths.mjs';
import { bridgeRequest } from './bridge.mjs';

export async function runningService(dataDir = DATA_HOME) {
  try { const status = await bridgeRequest('/api/status', { dataDir, timeoutMs: 1500 }); return status.ok ? status : null; } catch { return null; }
}
export async function startSupervisor(dataDir = DATA_HOME) {
  const config = readJson(path.join(dataDir, 'follow-config.json'), {});
  if (process.platform === 'win32' && config.launchMode === 'gpt-portable') {
    if (!config.launcherPath || !fs.existsSync(config.launcherPath) || !fs.existsSync(config.electronPath)) throw new Error('请先双击“启动大肥龙.cmd”准备桌面组件');
    const pause=path.join(dataDir,'pause-until-host-exit.json');
    if(fs.existsSync(pause))fs.unlinkSync(pause);
    const child=spawn(config.launcherPath,['--script',path.join(ROOT,'desktop','supervisor.ps1'),'--data',dataDir],{detached:true,stdio:'ignore',windowsHide:true});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();return;
  }
  if (process.platform === 'darwin') {
    if (config.platform !== 'darwin' || !['follow-codex', 'standalone'].includes(config.mode) || config.enabled !== true || !config.label) {
      throw new Error('请先运行 scripts/install-macos.mjs 安装 macOS 自动跟随');
    }
    const pause = path.join(dataDir, 'pause-until-host-exit.json');
    if (fs.existsSync(pause)) fs.unlinkSync(pause);
    const domain = 'gui/' + process.getuid();
    try {
      await promisify(execFile)('/bin/launchctl', ['kickstart', domain + '/' + config.label], { timeout: 10000 });
    } catch {
      throw new Error('macOS LaunchAgent 未能启动，请运行“安装 Mac 自动跟随.command”修复');
    }
    return;
  }
  if (config.taskName !== 'Codex API Balance Whale') throw new Error('请运行“安装自动跟随.cmd”以修复独立启动任务');
  const pause = path.join(dataDir, 'pause-until-host-exit.json');
  if (fs.existsSync(pause)) fs.unlinkSync(pause);
  const scheduler = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'schtasks.exe');
  try { await promisify(execFile)(scheduler, ['/Run', '/TN', config.taskName], { windowsHide: true, timeout: 10000 }); }
  catch { throw new Error('Windows 自动跟随任务未能启动，请运行“安装自动跟随.cmd”修复'); }
}
export async function ensureService({ dataDir = DATA_HOME } = {}) {
  let running = await runningService(dataDir);
  if (running && readJson(path.join(dataDir, 'pause-until-host-exit.json'), {}).pauseAll === true) {
    await stopService({ dataDir }); running = null;
  }
  if (running) return running;
  await startSupervisor(dataDir);
  for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 250)); running = await runningService(dataDir); if (running) return running; }
  throw new Error('挂件启动超时，请重新启动挂件或查看运行状态');
}
export async function serviceRequest(route, options = {}) { return bridgeRequest(route, options); }
export async function stopService({ dataDir = DATA_HOME } = {}) {
  // The persistent marker closes the gap before the supervisor creates its
  // stop event or before the Electron IPC server becomes ready.
  writeJson(path.join(dataDir, 'pause-until-host-exit.json'), { pauseAll: true, stoppedAt: new Date().toISOString() });
  const supervisor = readJson(path.join(dataDir, 'supervisor-state.json'), {});
  const runtime = readJson(path.join(dataDir, 'runtime.json'), {});
  try { await bridgeRequest('/api/stop', { method: 'POST', body: {}, dataDir, timeoutMs: 1500 }); } catch {}
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'desktop', 'supervisor.ps1'), '-DataDir', dataDir, '-Stop'], { windowsHide: true, timeout: 10000 });
  }
  const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  for (let i = 0; i < 75; i++) {
    if (!alive(supervisor.pid) && !alive(runtime.pid) && !(await runningService(dataDir))) return { ok: true, stopped: true };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('挂件仍在退出，请稍后重新检查运行状态');
}
export async function launchDesktop({ dataDir = DATA_HOME, mode = null } = {}) {
  if (mode != null && !['standalone', 'follow-codex'].includes(mode)) throw new Error('Invalid desktop mode');
  if (mode) { const file = path.join(dataDir, 'follow-config.json'); writeJson(file, { ...readJson(file, {}), mode }); }
  await ensureService({ dataDir });
  if (mode) await bridgeRequest('/api/desktop-mode', { method: 'POST', body: { mode }, dataDir });
  return bridgeRequest('/api/show', { method: 'POST', dataDir });
}
export function supervisorStatus(dataDir = DATA_HOME) {
  const config = readJson(path.join(dataDir, 'follow-config.json'), {});
  const installed = process.platform === 'darwin'
    ? config.platform === 'darwin' && config.enabled === true && !!config.label
    : config.launchMode === 'gpt-portable' || config.taskName === 'Codex API Balance Whale';
  return { installed, ...readJson(path.join(dataDir, 'supervisor-state.json'), {}) };
}
