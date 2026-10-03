import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createInsightsService} from '../runtime/insights.mjs';

test('manual refresh reads a newly appended Codex quota event within the normal cache period',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-quota-refresh-'));
  const auth=path.join(dir,'auth.json');fs.writeFileSync(auth,JSON.stringify({auth_mode:'chatgpt'}));
  fs.utimesSync(auth,new Date(Date.now()-60000),new Date(Date.now()-60000));
  const sessions=path.join(dir,'sessions');fs.mkdirSync(sessions);
  const file=path.join(sessions,'rollout-fixture.jsonl');
  const event=(used,at)=>JSON.stringify({type:'event_msg',timestamp:new Date(at).toISOString(),payload:{type:'token_count',rate_limits:{primary:{used_percent:used,window_minutes:300,resets_at:Math.floor(at/1000)+3600}}}})+'\n';
  fs.writeFileSync(file,event(20,Date.now()-1000));
  const config={codexHome:dir,resolve:()=>({id:'openai',key:'',accountId:'fixture',setting:{monitorSessions:true}})};
  const service=createInsightsService(config);
  t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true});});
  assert.equal((await service.get()).subscription.windows[0].usedPercent,20);
  fs.appendFileSync(file,event(30,Date.now()));
  assert.equal((await service.get({force:true})).subscription.windows[0].usedPercent,30);
});
