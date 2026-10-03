import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {pricingSchedule} from './pricing-schedule.mjs';
import {isSubscriptionAccount} from './account-mode.mjs';
import {createResetCreditsService} from './reset-credits.mjs';
function authSnapshot(config) {
  try{const file=path.join(config.codexHome,'auth.json'),stat=fs.statSync(file);
    return {auth:stat.size<1024*1024?JSON.parse(fs.readFileSync(file,'utf8')):{},changedAt:stat.mtimeMs};
  }catch{return {auth:{},changedAt:0};}
}
function identityKey(connection,auth,monitored) {
  return crypto.createHash('sha256').update(connection.accountId+'\0'+String(auth.tokens?.account_id||'')+'\0'+String(monitored)).digest('hex');
}
export function createInsightsService(config,{resetCreditsService=createResetCreditsService(config)}={}) {
  let cache=null,pending=null,lastKey='',worker=null,closed=false;
  async function get({force=false,resetForce=false,includeResetCredits=true}={}) {
    const now=Date.now(), c=config.resolve(), pricing=pricingSchedule(c,now);
    const monitored=c.setting.monitorSessions !== false;
    let {auth,changedAt:authChangedAt}=authSnapshot(config);
    const subscribed=isSubscriptionAccount(c,auth);
    // A new account or API mode invalidates the old cached view. Credential stays local.
    const key=identityKey(c,auth,monitored);
    auth=null;
    if(lastKey!==key){cache=null;lastKey=key;}
    if(!monitored || closed)return {ok:true,pricing,subscription:{available:false,windows:[],reason:'本机会话观测已关闭'},tokens:null};
    const resetJob=subscribed&&includeResetCredits?resetCreditsService.get({force:resetForce}):Promise.resolve(null);
    if(force || !cache || now-cache.at>30000){
      if(!pending)pending=new Promise(resolve=>{
        worker=new Worker(new URL('./insights-worker.mjs',import.meta.url),{workerData:{codexHome:config.codexHome,now}});
        const current=worker;let finished=false;
        const done=data=>{if(finished)return;finished=true;clearTimeout(timeout);void current.terminate();if(worker===current)worker=null;resolve(data);};
        const timeout=setTimeout(()=>done({error:'observation-timeout'}),8000);timeout.unref();
        current.once('message',done);current.once('error',()=>done({error:'local-observation-unavailable'}));current.once('exit',()=>done({error:'local-observation-unavailable'}));
      }).finally(()=>{pending=null;});
      const data=await pending; if(key===lastKey)cache={at:now,data};
    }
    const resetCredits=await resetJob;
    try {
      const current=config.resolve(),snapshot=authSnapshot(config);
      if(closed||key!==identityKey(current,snapshot.auth,current.setting.monitorSessions!==false))return {ok:true,tokens:null,subscription:{available:false,windows:[],resetCredits:null,reason:'登录状态已变化，请刷新'}};
    }catch{return {ok:true,tokens:null,subscription:{available:false,windows:[],resetCredits:null,reason:'登录状态暂不可读，请刷新'}};}
    const data=cache?.data||{},windows=subscribed && data.observedAt>=authChangedAt ? data.windows||[] : [];
    return {ok:true,pricing,tokens:data.tokens||null,subscription:{available:windows.length>0,windows,source:'local-log',observedAt:data.observedAt||null,
      resetCredits,
      reason:!subscribed?'当前连接不是可识别的 ChatGPT 订阅登录':windows.length?'来自本机会话的官方额度快照；不能换算为固定 token 配额':'尚未观测到订阅额度快照，请在订阅登录下使用 Codex 后刷新'},error:data.error||null};
  }
  return {get,async close(){closed=true;void worker?.terminate();worker=null;cache=null;await resetCreditsService.close();}};
}
