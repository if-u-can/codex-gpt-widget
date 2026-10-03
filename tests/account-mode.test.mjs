import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore} from '../runtime/config.mjs';
import {detectDisplayMode} from '../runtime/account-mode.mjs';

function fixture(t,{config='',auth={auth_mode:'chatgpt'},env={}}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-mode-'));
  fs.writeFileSync(path.join(dir,'config.toml'),config);
  fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify(auth));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return new ConfigStore({dataDir:dir,codexHome:dir,env});
}
test('official ChatGPT login selects subscription automatically',t=>{
  assert.equal(detectDisplayMode(fixture(t)),'subscription');
});
test('a relay provider selects its configured API balance even with leftover subscription tokens',t=>{
  const config=fixture(t,{config:'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.test/v1"\nexperimental_bearer_token="TEST_KEY"\n'});
  assert.equal(detectDisplayMode(config),'api');
  assert.equal(config.resolve().keySource,'codex-provider');
});
test('mixed official subscription and API keys select API consumption',t=>{
  assert.equal(detectDisplayMode(fixture(t,{env:{OPENAI_API_KEY:'TEST_KEY'}})),'api');
  assert.equal(detectDisplayMode(fixture(t,{auth:{auth_mode:'chatgpt',OPENAI_API_KEY:'TEST_KEY'}})),'api');
});
test('API login or an unidentified relay never reuses subscription quota',t=>{
  assert.equal(detectDisplayMode(fixture(t,{auth:{auth_mode:'apikey'}})),'api');
  assert.equal(detectDisplayMode(fixture(t,{config:'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.test/v1"\n'})),'api');
});
test('auto detection preserves the existing balance adapter and tolerates unreadable configuration',t=>{
  const config=fixture(t,{env:{OPENAI_API_KEY:'TEST_KEY'}});
  config.save({provider:'custom-json',balancePath:'/api/balance',balanceField:'data.balance',balanceScale:.01});
  const before=fs.readFileSync(config.file,'utf8');
  assert.equal(detectDisplayMode(config),'api');
  assert.equal(fs.readFileSync(config.file,'utf8'),before);
  assert.equal(config.resolve().setting.balancePath,'/api/balance');
  assert.equal(detectDisplayMode({resolve(){throw Error('temporary config error');}}),'api');
});
