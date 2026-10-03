import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaceGeometry,parseCoordinates} from './geometry.js';
import {projectAtlas} from './service.js';
import {parseTime} from './time.js';
test('route and region retain their own geometry and valid map anchor',()=>{
  const points=[[118,30],[120,30],[119,32]];
  const route=createPlaceGeometry('route',points);assert.equal(route.geometry.type,'LineString');assert.deepEqual(route.geometry.coordinates,points);
  const region=createPlaceGeometry('region',points);assert.equal(region.geometry.type,'Polygon');const ring=region.geometry.coordinates[0];assert.deepEqual(ring[0],ring.at(-1));assert.equal(ring.length,4);assert.ok(region.coordinates.every(Number.isFinite));
});
test('drawn place only explores its own ID, not enclosed cities',()=>{
  const places=[{id:'region',objectType:'place',data:{name:'区域',kind:'region',...createPlaceGeometry('region',[[118,30],[120,30],[120,32],[118,32]])}},{id:'city',objectType:'place',data:{name:'内部城市',kind:'city',coordinates:[119,31]}}];
  const entries=[{id:'e',objectType:'entry',data:{kind:'note',status:'adopted',occurrenceTime:parseTime('1850'),placeRefs:[{placeId:'region',confirmed:true}]}}];
  const projection=projectAtlas(entries,places,parseTime('1850'));assert.deepEqual(projection.explored,['region']);assert.equal(projection.total,1);assert.equal(projection.markers[0].geometry.type,'Polygon');
});
test('geometry rejects insufficient, collinear, duplicate, crossed or invalid points',()=>{
  for(const points of [[[0,0],[1,1]],[[0,0],[1,1],[2,2]],[[0,0],[1,1],[1,0],[0,1]],[[0,0],[1,1],[0,0],[1,0]],[[0,0],[1,1],[190,0]]])assert.throws(()=>createPlaceGeometry('region',points),{code:'INVALID_INPUT'});
  assert.throws(()=>createPlaceGeometry('route',[[0,0],[0,0]]),/两个不同点/);
});
test('text coordinates support keyboard fallback and retain a dateline anchor',()=>{
  assert.deepEqual(parseCoordinates('118, 30\n120，32'),[[118,30],[120,32]]);assert.throws(()=>parseCoordinates('118,30,4'),/每行/);assert.throws(()=>parseCoordinates('181,30'),/经度/);
  const route=createPlaceGeometry('route',[[179,20],[-179,22]]);assert.equal(route.coordinates[0],-180);
});
test('prefiltered entry IDs override text scans while preserving exploration counts',()=>{
  const places=[{id:'p',data:{name:'地点',coordinates:[118,30]}}];
  const entries=['first','second'].map(id=>({id,objectType:'entry',data:{title:'no body in metadata',status:'adopted',kind:'note',occurrenceTime:parseTime('1850'),placeRefs:[{placeId:'p',confirmed:true}]}}));
  for(const matchedEntryIds of [['second'],new Set(['second'])]){const result=projectAtlas(entries,places,null,{q:'正文关键词',matchedEntryIds});assert.equal(result.total,2);assert.equal(result.visibleTotal,1);assert.deepEqual(result.markers[0].visibleEntryIds,['second']);}
  assert.equal(projectAtlas(entries,places,null,{matchedEntryIds:[]}).visibleTotal,0);
});
