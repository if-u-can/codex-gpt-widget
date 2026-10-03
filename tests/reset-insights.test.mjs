import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createInsightsService} from '../runtime/insights.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-reset-insights-'));
  fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt'}));
  let connection={id:'openai',key:'',accountId:'fixture',setting:{monitorSessions:true}},closed=false;
  const calls=[], resets={async get(options){calls.push(options);return {state:'observed',availableCount:0,source:'official-app-server',observedAt:Date.now()};},close(){closed=true;}};
  const config={codexHome:dir,resolve:()=>connection};
  const service=createInsightsService(config,{resetCreditsService:resets});
  t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {service,calls,setConnection(next){connection=next;},get closed(){return closed;}};
}
test('official reset counts survive empty logs and turn sampling reuses reset cache',async t=>{
  const f=fixture(t);
  const first=await f.service.get({force:true});
  assert.equal(first.subscription.resetCredits.availableCount,0);
  assert.equal(first.subscription.resetCredits.state,'observed');
  assert.deepEqual(f.calls,[{force:false}]);
  await f.service.get({force:true,resetForce:true});
  assert.deepEqual(f.calls[1],{force:true});
  await f.service.get({force:true,includeResetCredits:false});
  assert.equal(f.calls.length,2);
  await f.service.close();assert.equal(f.closed,true);
});
test('API key mode never requests or exposes subscription reset credits',async t=>{
  const f=fixture(t);
  f.setConnection({id:'openai',key:'TEST-ONLY-KEY',accountId:'fixture',setting:{monitorSessions:true}});
  assert.equal((await f.service.get({force:true,resetForce:true})).subscription.resetCredits,null);
  assert.deepEqual(f.calls,[]);
});
test('account switches while a reset request is pending cannot expose old quota or reset counts',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-reset-switch-'));
  const auth=path.join(dir,'auth.json');fs.writeFileSync(auth,JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'account-a'}}));
  let release;const resetCreditsService={get:()=>new Promise(resolve=>{release=resolve;}),close(){}};
  const config={codexHome:dir,resolve:()=>({id:'openai',key:'',accountId:'fixture',setting:{monitorSessions:true}})};
  const service=createInsightsService(config,{resetCreditsService});
  t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
  const pending=service.get();
  fs.writeFileSync(auth,JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'account-b'}}));
  release({state:'observed',availableCount:99});
  const data=await pending;
  assert.equal(data.subscription.available,false);assert.equal(data.subscription.resetCredits,null);assert.equal(data.tokens,null);
});
