import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WhaleService} from '../runtime/service.mjs';
import {ConfigStore} from '../runtime/config.mjs';

test('consumption bubble template is available and retains edited tokens placeholder across restart',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-template-'));
 const config=new ConfigStore({dataDir:dir,codexHome:dir,env:{}});
 const service=new WhaleService({config});t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.ok(service.readUsageSettings().turnCost?.lines.some(line=>line.text?.includes('{tokens}')));
 assert.deepEqual(service.readUsageSettings().turnCost.lines.map(line=>line.text),['上一轮对话消耗：','{consumption}','吃了 {tokens} token']);
 const lines=[{type:'text',text:'消耗 {quota_percent}，吃了 {tokens} token',size:6,bold:true},{type:'random',lines:[{t:'这次 {consumption}',w:1}],size:3},{type:'image',imgId:'bimg_petpet',size:6},{type:'link',text:'查看详情',url:'https://example.test',size:2}];
 service.writeUsageSettings({turnCost:{lines}});
 assert.deepEqual(new WhaleService({config}).readUsageSettings().turnCost.lines,lines);
});
