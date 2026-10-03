import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {ROOT,DATA_HOME,readJson,writeJson} from '../runtime/paths.mjs';
import {launchDesktop,runningService} from '../runtime/process.mjs';

if(process.platform!=='win32')throw Error('此交付版本验证的是 Windows 桌面挂件。');
if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24 或更新版本。');
const electronPath=path.join(DATA_HOME,'desktop-runtime','node_modules','electron','dist','electron.exe');
if(!fs.existsSync(electronPath)) {
  process.stdout.write('首次启动，正在准备桌面组件…\n');
  const child=spawn(process.execPath,[path.join(ROOT,'scripts','install-desktop.mjs')],{stdio:'inherit',windowsHide:true});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)throw Error('桌面组件准备失败，请检查网络后重新启动。');
}
const powershell=path.join(process.env.WINDIR||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const launcherPath=execFileSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','build-launcher.ps1'),'-DataDir',DATA_HOME],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).at(-1);
const current=readJson(path.join(DATA_HOME,'follow-config.json'),{});
writeJson(path.join(DATA_HOME,'display-mode.json'),{version:1,mode:'auto'});
writeJson(path.join(DATA_HOME,'follow-config.json'),{...current,enabled:true,pluginRoot:ROOT,electronPath,launcherPath,launchMode:'gpt-portable',mode:process.argv.includes('--desktop')?'standalone':'follow-codex'});
const result=await launchDesktop({mode:process.argv.includes('--desktop')?'standalone':'follow-codex'});
if(!result.ok)throw Error('挂件未能启动，请重新启动或查看运行状态。');
const status=await runningService();
process.stdout.write(JSON.stringify({ok:status?.ok===true,name:'大肥龙',mode:status?.desktopMode||current.mode||'follow-codex',waitingForCodex:status?.waitingForCodex===true,message:status?.waitingForCodex?'未连接 Codex，等待启动':'挂件已启动'})+'\n');
