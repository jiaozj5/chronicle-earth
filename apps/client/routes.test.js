import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRoute,routeHash} from './routes.js';
test('conversion links preserve the selected task within the library',()=>{
 for(const hash of ['#convert?id=importJob_a','#library?section=convert&id=importJob_a']){
  const next=parseRoute(hash);assert.deepEqual(next,{route:'library',params:{section:'convert',objectId:'importJob_a'}});
  assert.equal(routeHash(next.route,next.params),'#library?section=convert&id=importJob_a');
 }
 assert.equal(routeHash('convert'),'#library?section=convert');
 assert.deepEqual(parseRoute('#library?section=convert'),{route:'library',params:{section:'convert'}});
});
test('reader version survives navigation serialization',()=>{
 const params={objectId:'publication_a',renditionId:'rendition_old',revision:3};
 assert.deepEqual(parseRoute(routeHash('library',params)),{route:'library',params});
 assert.deepEqual(parseRoute('#library'),{route:'library',params:{}});
});
