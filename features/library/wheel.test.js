import test from 'node:test';
import assert from 'node:assert/strict';
import {wheelPager,wheelPixels,wheelZoom,bindReaderWheel} from './wheel.js';

test('wheel gesture turns once, ignores inertia, accepts a fresh gesture and reversal',()=>{
 const p=wheelPager();assert.equal(p.feed(12,0),0);assert.equal(p.feed(30,20),1);assert.equal(p.feed(100,40),0);assert.equal(p.feed(10,170),0);assert.equal(p.feed(100,400),1);assert.equal(p.feed(-100,520),-1);
});
test('a zoomed page scrolls first, and reaching its end needs a fresh gesture to turn',()=>{
 const p=wheelPager();assert.equal(p.feed(120,0,{scrollable:true}),0);assert.equal(p.feed(120,20),0);assert.equal(p.feed(120,250),1);p.reset();assert.equal(p.feed(120,300,{busy:true}),0);assert.equal(p.feed(120,320),0);assert.equal(p.feed(120,600),1);
});
test('Ctrl wheel cancels browser zoom and changes only book scale; sidebar scrolling never turns',()=>{
 const root=new EventTarget(),stage=Object.assign(new EventTarget(),{clientHeight:600,scrollTop:0,scrollHeight:600}),turns=[];let scale=1,time=0;
 const dispose=bindReaderWheel({root,stage,pager:wheelPager(),isBlocked:()=>false,isReader:()=>true,getScale:()=>scale,onZoom:value=>scale=value,onTurn:value=>turns.push(value),now:()=>time});
 const wheel=(target,props)=>{const e=Object.assign(new Event('wheel',{cancelable:true}),{deltaY:120,deltaX:0,deltaMode:0,ctrlKey:false,metaKey:false,...props});target.dispatchEvent(e);return e;};
 assert.equal(wheel(root,{ctrlKey:true,deltaY:-120}).defaultPrevented,true);assert.ok(scale>1);assert.deepEqual(turns,[]);wheel(stage,{ctrlKey:true});assert.deepEqual(turns,[]);
 wheel(root,{});assert.deepEqual(turns,[]);assert.equal(wheel(stage,{}).defaultPrevented,true);assert.deepEqual(turns,[1]);time=500;stage.scrollHeight=1200;assert.equal(wheel(stage,{}).defaultPrevented,false);assert.deepEqual(turns,[1]);dispose();time=900;stage.scrollHeight=600;wheel(stage,{});assert.deepEqual(turns,[1]);
 assert.equal(wheelZoom(3,-150),3);assert.equal(wheelZoom(.5,150),.5);assert.equal(wheelPixels(3,1),48);assert.equal(wheelPixels(1,2,720),720);
});
