import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WhaleService} from '../runtime/service.mjs';
import {ConfigStore} from '../runtime/config.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dragon-budget-')),config=new ConfigStore({dataDir:dir,codexHome:dir,env:{}}),service=new WhaleService({config});t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});return {service,dir};}
test('budget amount, switch, close behavior and edited modules survive reopening',t=>{
  const {service}=fixture(t),lines=[{type:'text',text:'自定义提醒 {currency}{amount}',size:4},{type:'random',lines:[{t:'慢慢来',w:1}],size:2}];
  service.writeUsageSettings({budget:{on:true,amount:3.25,lines,autoClose:true,ttlSec:9}});
  const saved=new WhaleService({config:service.config}).readUsageSettings().budget;
  assert.equal(saved.amount,3.25);assert.equal(saved.ttlSec,9);assert.equal(saved.autoClose,true);assert.deepEqual(saved.lines,lines);
});
test('upgrading only old stock reminder preserves its configured threshold and switch',t=>{
  const {service,dir}=fixture(t);
  fs.writeFileSync(path.join(dir,'usage-settings.json'),JSON.stringify({budget:{on:false,amount:7.5,autoClose:false,lines:[{type:'text',text:'今天已观测用量超过',size:6,bold:true},{type:'text',text:'{currency}{amount}',size:7,bold:true,rgb:'rouge'}]}}));
  const budget=service.readUsageSettings().budget;
  assert.equal(budget.amount,7.5);assert.equal(budget.on,false);assert.equal(budget.autoClose,false);
  assert.deepEqual(budget.lines.map(line=>line.text),['老大～今天花销超过','{currency}{amount}','再花就要变穷光蛋啦～']);
});

test('previous stock alert and budget upgrade together while all preferences persist',t=>{
  const {service,dir}=fixture(t),dashboard=service.config.resolve().dashboardUrl;
  fs.writeFileSync(path.join(dir,'usage-settings.json'),JSON.stringify({
    alert:{on:false,below:3.5,autoClose:true,ttlSec:11,lines:[
      {type:'text',text:'老大～你的 API 余额',size:5,bold:true},
      {type:'text',text:'已经不足 {currency}{below} 啦',size:6,bold:true,rgb:'rouge'},
      {type:'image',imgId:'bimg_yue_money',size:6,imgScale:0.3},
      {type:'link',text:'打开当前 API 账单',url:dashboard,size:2,color:'#ffffff',bgRgb:'indigo'},
    ]},
    budget:{on:false,amount:8.5,autoClose:true,ttlSec:12,lines:[
      {type:'text',text:'今天吃得有点多了',size:5,bold:true},
      {type:'text',text:'{currency}{amount}',size:16,bold:true,color:'#e0433f'},
      {type:'text',text:'token 小零食，先缓一缓。',size:2,color:'#8a83a0'},
    ]},
  }));
  const saved=service.readUsageSettings();
  assert.equal(saved.alert.on,false);assert.equal(saved.alert.below,3.5);assert.equal(saved.alert.ttlSec,11);
  assert.equal(saved.alert.lines[1].text,'已经不足 {currency}{below} 啦～');
  assert.equal(saved.alert.lines[2].imgId,'bimg_yue_money');assert.equal(saved.alert.lines[3].url,dashboard);
  assert.equal(saved.alert.lines[3].text,'>> 给大肥龙加餐 <<');
  assert.equal(saved.budget.on,false);assert.equal(saved.budget.amount,8.5);assert.equal(saved.budget.ttlSec,12);
  assert.equal(saved.budget.lines[0].text,'老大～今天花销超过');
});

test('edited stock wording, styling and links are retained rather than inferred as defaults',t=>{
  const {service}=fixture(t);
  const customBudget=[{type:'text',text:'今天已观测用量超过',size:6,bold:true,color:'#ff00ff'},{type:'text',text:'{currency}{amount}',size:7,bold:true,rgb:'rouge'}];
  const customAlert=service.readUsageSettings().alert.lines;
  customAlert[3].url='https://example.com/custom-topup';
  service.writeUsageSettings({alert:{lines:customAlert},budget:{lines:customBudget}});
  const saved=new WhaleService({config:service.config}).readUsageSettings();
  assert.deepEqual(saved.alert.lines,customAlert);assert.deepEqual(saved.budget.lines,customBudget);
});

test('shipped official alert link upgrades after provider switch; separately edited old link survives',t=>{
  const {service,dir}=fixture(t);
  const official='https://platform.openai.com/settings/organization/billing/overview';
  service.config.env.OPENAI_BASE_URL='https://example.com/v1';
  const oldLines=url=>[
    {type:'text',text:'老大～你的 API 余额',size:5,bold:true},
    {type:'text',text:'已经不足 {currency}{below} 啦',size:6,bold:true,rgb:'rouge'},
    {type:'image',imgId:'bimg_yue_money',size:6,imgScale:0.3},
    {type:'link',text:'打开当前 API 账单',url,size:2,color:'#ffffff',bgRgb:'indigo'},
  ];
  fs.writeFileSync(path.join(dir,'usage-settings.json'),JSON.stringify({alert:{on:false,below:4.5,autoClose:true,ttlSec:13,lines:oldLines(official)}}));
  const upgraded=service.readUsageSettings().alert;
  assert.equal(upgraded.lines[1].text,'已经不足 {currency}{below} 啦～');
  assert.equal(upgraded.lines[3].url,service.config.resolve().dashboardUrl);
  assert.equal(upgraded.on,false);assert.equal(upgraded.below,4.5);assert.equal(upgraded.autoClose,true);assert.equal(upgraded.ttlSec,13);
  const custom=oldLines('https://example.com/custom-topup');
  fs.writeFileSync(path.join(dir,'usage-settings.json'),JSON.stringify({alert:{lines:custom}}));
  assert.deepEqual(service.readUsageSettings().alert.lines,custom);
});
