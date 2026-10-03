import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTime,toRange,overlaps} from './time.js';
import {renameTimeView,removeTimeView,splitTimeView,mergeTimeViews} from './view-operations.js';
const view=(id,text)=>({id,objectType:'timeView',revision:3,data:{name:id,timeSpec:parseTime(text)}});
test('split and merge create only timeView changes with contiguous half-open boundaries',()=>{
  const original=view('nineteenth','1800—1899'),entry={id:'unaltered-record',data:{title:'Untouched',occurrenceTime:parseTime('1850')}};
  const changes=splitTimeView(original,'1850');
  assert.equal(changes.length,3);assert.ok(changes.every(c=>c.objectType==='timeView'));assert.equal(changes[2].deleted,true);assert.equal(changes[2].expectedRevision,3);
  const first=toRange(changes[0].data.timeSpec),second=toRange(changes[1].data.timeSpec),range=toRange(original.data.timeSpec);
  assert.equal(first.startDay,range.startDay);assert.equal(first.endDayExclusive,second.startDay);assert.equal(second.endDayExclusive,range.endDayExclusive);assert.equal(overlaps(first,second),false);
  assert.equal(overlaps(entry.data.occurrenceTime,first),false);assert.equal(overlaps(entry.data.occurrenceTime,second),true);
  const merged=mergeTimeViews(changes.slice(0,2).map(c=>({...c,revision:1})),'重新合并');assert.deepEqual(toRange(merged[0].data.timeSpec),range);assert.equal(entry.id,'unaltered-record');
});
test('split uses calendar boundaries across BCE/CE without year zero',()=>{
  const changes=splitTimeView(view('era','公元前2年至公元2年'),'公元1年');
  assert.equal(changes[0].data.timeSpec.latest.era,'BCE');assert.equal(changes[0].data.timeSpec.latest.year,1);assert.equal(changes[1].data.timeSpec.earliest.year,1);assert.equal(changes[1].data.timeSpec.earliest.era,'CE');
});
test('split refuses outside, uncertain, duration, empty and invalid date boundaries',()=>{
  for(const at of ['1799','1800','1900','约1850','1850—1860','','2023-02-29'])assert.throws(()=>splitTimeView(view('v','1800—1899'),at),{code:'INVALID_INPUT'});
});
test('merge rejects disjoint time without silently filling its gap',()=>{
  assert.throws(()=>mergeTimeViews([view('a','1800—1849'),view('b','1851—1899')],'间隙'),/未覆盖/);
  const changes=mergeTimeViews([view('a','1800—1850'),view('b','1850—1899')],'交叠');assert.equal(changes.length,3);assert.deepEqual(toRange(changes[0].data.timeSpec),toRange(parseTime('1800—1899')));
});
test('rename and delete preserve exact time query and expected revision',()=>{
  const v=view('v','1850');assert.deepEqual(renameTimeView(v,'新名字'),{id:'v',objectType:'timeView',expectedRevision:3,data:{...v.data,name:'新名字'}});assert.deepEqual(removeTimeView(v).data,v.data);assert.equal(removeTimeView(v).deleted,true);
});
