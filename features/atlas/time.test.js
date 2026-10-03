import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTime,toRange,overlaps,formatTime} from './time.js';

test('CE year/month/day retain precision and half-open inclusive range',()=>{
 const year=toRange(parseTime('2024'));assert.equal(year.endDayExclusive-year.startDay,366);
 const feb=toRange(parseTime('2024-02'));assert.equal(feb.endDayExclusive-feb.startDay,29);
 const leap=toRange(parseTime('2024年2月29日'));assert.equal(leap.endDayExclusive-leap.startDay,1);
 assert.equal(parseTime('2024-02').precision,'month');assert.equal(formatTime(parseTime('1850')),'1850年');
});
test('invalid dates and year zero receive a field error',()=>{
 for(const value of ['2023-02-29','1900-02-29','2024-13-01','2024-04-31','0年','公元前0年'])assert.throws(()=>parseTime(value),{code:'INVALID_INPUT'});
 assert.equal(toRange(parseTime('2000-02-29')).indexed,true);
});
test('BCE chronology has no displayed year zero and crosses eras',()=>{
 const bce=toRange(parseTime('公元前1年'));const ce=toRange(parseTime('公元1年'));
 assert.equal(bce.endDayExclusive,ce.startDay);assert.equal(overlaps(parseTime('公元前1年'),parseTime('公元1年')),false);
 const cross=parseTime('公元前2年—公元1年');assert.equal(cross.latest.era,'CE');assert.equal(overlaps(cross,parseTime('公元前1年')),true);
 assert.equal(parseTime('公元前1年以后').earliest.year,1);assert.equal(parseTime('公元前1年以后').earliest.era,'CE');
 assert.equal(parseTime('公元1年以前').latest.era,'BCE');assert.equal(parseTime('公元1年以前').latest.year,1);
});
test('open ranges distinguish strict and inclusive boundary semantics',()=>{
 const after=parseTime('1850年以后'),before=parseTime('1850年以前');
 assert.equal(after.earliest.year,1851);assert.equal(after.latest,null);assert.equal(before.latest.year,1849);assert.equal(before.earliest,null);
 assert.equal(overlaps(after,parseTime('1850')),false);assert.equal(overlaps(after,parseTime('1851')),true);
 assert.equal(overlaps(parseTime('从1850年起'),parseTime('1850')),true);
 assert.equal(overlaps(parseTime('截至1850年'),parseTime('1850')),true);
 assert.equal(overlaps(parseTime('1850年及以后'),parseTime('1850')),true);
});
test('unknown, approximate and unindexed historical words remain truthful',()=>{
 for(const value of ['时间不详','某朝时期','1850年前后']){const s=parseTime(value);assert.equal(toRange(s).indexed,false);assert.equal(s.originalText,value);}
 assert.equal(parseTime('约1850年').approximate,true);
 assert.equal(toRange(parseTime('公元前10000年')).indexed,true);assert.equal(toRange(parseTime('10000年')).indexed,true);
 for(const value of ['公元前10001年','10001年']){const s=parseTime(value);assert.equal(toRange(s).indexed,false);assert.equal(s.originalText,value);assert.notEqual(s.earliest,null);}
});
test('duration and uncertain range compare equally while visibly distinct',()=>{
 const d=parseTime('1850—1860年'),u=parseTime('1850—1860年之间');
 assert.equal(d.kind,'duration');assert.equal(u.kind,'uncertain');assert.equal(overlaps(d,u),true);
 assert.match(formatTime(u),/不确定/);assert.match(formatTime(d),/持续/);
 assert.equal(toRange(parseTime('1860—1850')).indexed,false);
});
