import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberedPage,pageNavigator} from './reading-state.js';
import {categoryOf} from './room.js';

test('rapid turns coalesce without racing and preserve latest direction',async()=>{
 let page=0,release;const seen=[],nav=pageNavigator({current:()=>page,count:()=>10,turn:async i=>{seen.push(i);if(i===1)await new Promise(r=>release=r);page=i;}});
 const first=nav.step(1);nav.step(1);nav.step(1);nav.step(-1);release();await first;assert.equal(page,2);assert.deepEqual(seen,[1,2]);assert.equal(await nav.go(100),false);
});
test('failed save cancels queued turns and allows explicit retry',async()=>{
 let fail=true,release;const pages=[],nav=pageNavigator({current:()=>0,count:()=>5,turn:async i=>{if(fail){await new Promise(r=>release=r);throw Error('disk full');}pages.push(i);}});
 const first=nav.go(1);nav.go(2);release();await assert.rejects(first,/disk full/);fail=false;await nav.go(1);assert.deepEqual(pages,[1]);
});
test('remembered page validates storage and clamps shorter revisions; classification respects explicit shelves',()=>{
 assert.equal(rememberedPage({getItem:()=>'{bad'},'book',10),0);assert.equal(rememberedPage({getItem:()=>'{"pageIndex":25}'},'book',10),9);assert.equal(rememberedPage({getItem:()=>'{"pageIndex":-2}'},'book',10),0);
 assert.equal(categoryOf({title:'深度表征学习',shelf:'未分类'}),'计算与智能');assert.equal(categoryOf({title:'深度表征学习',shelf:'我的课题'}),'我的课题');assert.equal(categoryOf({title:'远山'}),'随手阅读');
});
