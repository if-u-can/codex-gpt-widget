import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isSubscriptionAccount} from './account-mode.mjs';

const source='official-app-server';
const unknown=reason=>({availableCount:null,observedAt:null,state:'unknown',source,reason});
function accountContext(config) {
  try {
    const connection=config.resolve(),file=path.join(config.codexHome,'auth.json');
    if(fs.statSync(file).size>=1024*1024)return null;
    const auth=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!isSubscriptionAccount(connection,auth))return null;
    const account=auth.tokens?.account_id,token=auth.tokens?.access_token;
    if(typeof account!=='string'||!account.trim()||typeof token!=='string'||!token)return null;
    return {identity:createHash('sha256').update(String(connection.accountId)+'\0'+account).digest('hex'),account,token};
  }catch{return null;}
}
async function executable(config,signal) {
  for(const candidate of [config.codexExecutable,config.env?.CODEX_CLI_PATH,process.env.CODEX_CLI_PATH]) {
    if(typeof candidate==='string'&&path.isAbsolute(candidate)&&fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return candidate;
  }
  if(process.platform==='win32') {
    const ps=path.join(process.env.WINDIR||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout}=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',"(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"],{windowsHide:true,timeout:4000,maxBuffer:8192,signal});
    const location=stdout.trim();
    if(location&&path.isAbsolute(location))for(const relative of ['app/resources/codex.exe','app/resources/bin/codex.exe']) {
      const file=path.join(location,relative);if(fs.existsSync(file))return file;
    }
  }
  throw Error('executable-unavailable');
}
async function readOfficial(config,context,signal,spawnImpl=spawn) {
  const binary=await executable(config,signal);
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-reset-query-'));
  let child,exited;
  try {
    fs.writeFileSync(path.join(home,'config.toml'),'model_provider="openai"\ncli_auth_credentials_store="file"\n',{mode:0o600});
    const env={...process.env,CODEX_HOME:home};
    for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CODEX_CHATGPT_BASE_URL','ELECTRON_RUN_AS_NODE'])delete env[key];
    if(signal.aborted)throw Error('aborted');
    child=spawnImpl(binary,['app-server'],{env,windowsHide:true,stdio:['pipe','pipe','ignore']});
    exited=new Promise(resolve=>child.once('close',resolve));
    let serial=0,buffer='',ended=false;
    const jobs=new Map();
    const fail=reason=>{ended=true;for(const job of jobs.values())job.reject(Error(reason));jobs.clear();};
    const write=packet=>{if(ended||child.stdin.destroyed)throw Error('connection-ended');child.stdin.write(JSON.stringify(packet)+'\n');};
    const request=(method,params)=>new Promise((resolve,reject)=>{
      const id=++serial;jobs.set(id,{resolve,reject});
      try{write({id,method,params});}catch{jobs.delete(id);reject(Error('connection-ended'));}
    });
    const abort=()=>{fail('aborted');try{child.kill();}catch{}};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    child.on('error',()=>fail('server-unavailable'));
    child.stdin.on('error',()=>fail('server-unavailable'));
    child.once('close',()=>fail('server-ended'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>8*1024*1024){fail('response-too-large');try{child.kill();}catch{}return;}
      let newline;
      while((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        let packet;try{packet=JSON.parse(line);}catch{continue;}
        if(packet.method&&packet.id!==undefined) {
          try{write({id:packet.id,error:{code:-32000,message:'Host request unavailable'}});}catch{}
          if(packet.method==='account/chatgptAuthTokens/refresh')fail('auth-refresh-required');
          continue;
        }
        const job=jobs.get(packet.id);if(!job)continue;jobs.delete(packet.id);
        if(packet.error)job.reject(Error('query-unavailable'));else job.resolve(packet.result);
      }
    });
    try {
      await request('initialize',{clientInfo:{name:'codex-gpt-widget',title:'大肥龙',version:'0.1.0'},capabilities:{experimentalApi:true}});
      write({method:'initialized'});
      await request('account/login/start',{type:'chatgptAuthTokens',accessToken:context.token,chatgptAccountId:context.account});
      return await request('account/rateLimits/read',{});
    }finally{signal.removeEventListener('abort',abort);fail('closed');}
  }finally{
    if(child){try{child.stdin.end();child.kill();}catch{};let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,1500);})]);clearTimeout(timer);}
    fs.rmSync(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}

export function createResetCreditsService(config,{readImpl,spawnImpl=spawn,timeoutMs=12000,cacheMs=60000}={}) {
  let cache=null,pending=null,lastIdentity=null,closed=false;
  const active=new Set();
  async function get({force=false}={}) {
    if(closed)return unknown('closed');
    const context=accountContext(config);
    if(!context){pending?.controller.abort();cache=null;lastIdentity=null;return unknown('subscription-auth-unavailable');}
    if(lastIdentity!==context.identity){pending?.controller.abort();pending=null;cache=null;lastIdentity=context.identity;}
    if(!force&&cache&&Date.now()-cache.at<cacheMs)return cache.value;
    if(pending?.identity===context.identity)return pending.job;
    const controller=new AbortController(),entry={identity:context.identity,controller};
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    entry.job=Promise.resolve().then(async()=>{
      let value,abortListener;
      try {
        const operation=readImpl?readImpl({identity:context.identity,signal:controller.signal}):readOfficial(config,context,controller.signal,spawnImpl);
        entry.cleanup=readImpl?null:Promise.resolve(operation).catch(()=>{});
        const cancelled=new Promise((_,reject)=>{abortListener=()=>reject(Error('aborted'));controller.signal.addEventListener('abort',abortListener,{once:true});if(controller.signal.aborted)abortListener();});
        const result=await Promise.race([operation,cancelled]);
        const count=result?.rateLimitResetCredits?.availableCount;
        value=Number.isSafeInteger(count)&&count>=0?{availableCount:count,observedAt:Date.now(),state:'observed',source}:unknown('count-not-provided');
      }catch{value=unknown(timedOut?'request-timeout':controller.signal.aborted?'query-cancelled':'query-unavailable');}
      finally{clearTimeout(timer);if(abortListener)controller.signal.removeEventListener('abort',abortListener);}
      const current=accountContext(config);
      if(closed||controller.signal.aborted||!current||current.identity!==entry.identity)return unknown(closed?'closed':timedOut?'request-timeout':'account-changed-or-query-cancelled');
      cache={at:Date.now(),value};return value;
    }).finally(async()=>{await entry.cleanup;active.delete(entry);if(pending===entry)pending=null;});
    active.add(entry);
    pending=entry;return entry.job;
  }
  async function close(){
    closed=true;cache=null;
    const entries=[...active];
    for(const entry of entries)entry.controller.abort();
    await Promise.allSettled(entries.map(entry=>entry.job));
  }
  return {get,close};
}
