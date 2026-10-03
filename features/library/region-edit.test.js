import test from 'node:test';
import assert from 'node:assert/strict';
import {transformRegion} from './region-edit.js';
import {regionTarget} from './selection.js';
import {resolveTargets} from './model.js';
const target={kind:'region',pageIndex:0,rect:[.2,.3,.25,.15]},bounds={width:800,height:1000};
test('Dragging preserves dimensions and clamps to the page at every zoom',()=>{
 const moved=transformRegion(target,'move',80,100,bounds);assert.ok(Math.abs(moved.rect[0]-.3)<1e-12);assert.equal(moved.rect[1],.4);assert.deepEqual(moved.rect.slice(2),target.rect.slice(2));
 assert.deepEqual(transformRegion(target,'move',8000,-8000,bounds).rect,[.75,0,.25,.15]);
 assert.deepEqual(moved,transformRegion(target,'move',160,200,{width:1600,height:2000}));
});
test('All eight resize handles stay valid and cannot flip or leave the page',()=>{
 for(const h of ['nw','n','ne','e','se','s','sw','w'])for(const delta of [-5000,0,5000]){const resized=transformRegion(target,h,delta,delta,bounds);assert.doesNotThrow(()=>resolveTargets({pages:[{}]},[resized]));assert.ok(resized.rect[2]>=8/bounds.width-1e-12);assert.ok(resized.rect[3]>=8/bounds.height-1e-12);}
});
test('Explicit drawing tools place useful default shapes on click',()=>{
 for(const type of ['triangle','circle','highlight','rectangle','underline']){const point={x:800,y:1000},t=regionTarget(point,point,bounds,type,0,{allowClick:true});assert.ok(t.rect[2]*800>=60);assert.ok(t.rect[3]*1000>=22);assert.doesNotThrow(()=>resolveTargets({pages:[{}]},[t]));}
});
