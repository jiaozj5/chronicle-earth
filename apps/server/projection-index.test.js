import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {parseTime} from '../../features/atlas/time.js';
import {projectAtlas} from '../../features/atlas/service.js';
import {projectionIndex,timeFilteredIds} from './projection-index.js';

test('metadata projection follows committed edits, deletion, restoration and workspace identity',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'chronicle-projection-'));const workspace=new Workspace(path.join(directory,'a')),other=new Workspace(path.join(directory,'b'));
 const commit=(id,data,expectedRevision=0,deleted)=>workspace.commit({requestId:crypto.randomUUID(),changes:[{id,objectType:id.startsWith('place')?'place':'entry',expectedRevision,data,...(deleted===undefined?{}:{deleted})}]}).objects[0];
 try{
  commit('place_a',{name:'甲城',kind:'city',coordinates:[110,30]});commit('place_b',{name:'乙城',kind:'city',coordinates:[115,35]});
  const first=commit('entry_1',{body:'正文保留在真实存储',kind:'note',status:'adopted',occurrenceTime:parseTime('1850'),placeRefs:[{placeId:'place_a',confirmed:true}],citations:[]});
  let index=projectionIndex(workspace);assert.equal(index.entries.get(first.id).data.body,undefined);assert.equal(workspace.get(first.id).data.body,first.data.body);
  assert.deepEqual(timeFilteredIds(index,parseTime('1850')),[first.id]);
  const changed=commit(first.id,{...first.data,occurrenceTime:parseTime('1860'),placeRefs:[{placeId:'place_b',confirmed:true}]},1);index=projectionIndex(workspace);
  assert.deepEqual(timeFilteredIds(index,parseTime('1850')),[]);assert.deepEqual(timeFilteredIds(index,parseTime('1860')),[first.id]);
  const projection=()=>{const i=projectionIndex(workspace);return projectAtlas([...i.entries.values()],[...i.places.values()],parseTime('1860'));};
  assert.deepEqual(projection().explored,['place_b']);commit(changed.id,changed.data,2,true);assert.equal(projection().total,0);
  index=projectionIndex(workspace);assert.deepEqual(timeFilteredIds(index,parseTime('1860'),{onlyDeleted:true}),[first.id]);commit(changed.id,changed.data,3,false);assert.deepEqual(projection().explored,['place_b']);
  assert.equal(projectionIndex(other).entries.size,0);
 }finally{workspace.close();other.close();const resolved=path.resolve(directory);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));await rm(resolved,{recursive:true,force:true});}
});
