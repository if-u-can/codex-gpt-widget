import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {workAreaInViewport}=createRequire(import.meta.url)('../desktop/work-area.cjs');
test('maximized host overflow stops at the taskbar rather than the client bottom',()=>{
  assert.deepEqual(workAreaInViewport({x:0,y:0,width:1707,height:1029},{x:0,y:0,width:1707,height:1027}),{left:0,top:0,right:1707,bottom:1027});
});
test('a window crossing any taskbar edge gets the intersection in client coordinates',()=>{
  assert.deepEqual(workAreaInViewport({x:-8,y:-8,width:1016,height:716},{x:40,y:40,width:920,height:620}),{left:48,top:48,right:968,bottom:668});
  assert.deepEqual(workAreaInViewport({x:-1600,y:50,width:1000,height:700},{x:-1920,y:0,width:1920,height:1040}),{left:0,top:0,right:1000,bottom:700});
});
test('invalid geometry cannot change the limits',()=>{
  assert.equal(workAreaInViewport({x:NaN,y:0,width:2,height:3},{x:0,y:0,width:1,height:1}),null);
  assert.equal(workAreaInViewport(null,{x:0,y:0,width:1,height:1}),null);
});
