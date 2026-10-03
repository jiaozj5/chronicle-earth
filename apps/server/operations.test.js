import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {parseTime} from '../../features/atlas/time.js';
import {projectAtlas} from '../../features/atlas/service.js';
import {validateCommit} from './validate.js';
import {createOperationsService} from './operations.js';
import {createAppServer} from './main.js';

async function fixture(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'chronicle-operations-'));
 let workspace=new Workspace(directory),validations=0;
 const service=createOperationsService({getWorkspace:()=>workspace,validateCommit:async(...args)=>{validations++;return validateCommit(...args);}});
 t.after(async()=>{workspace.close();assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(directory,{recursive:true,force:true});});
 const run=(operation,args={},requestId)=>service.execute({version:'1',operation,arguments:args,...(requestId?{requestId}:{})});
 const seed=(id,data,objectType='place',expectedRevision=0)=>workspace.commit({requestId:crypto.randomUUID(),changes:[{id,objectType,expectedRevision,data}]}).objects[0];
 const place=seed('place_local',{name:'长安',kind:'city',coordinates:[108.9,34.3],aliases:['西安'],userCreated:true});
 return{run,seed,place,service,get workspace(){return workspace;},get validations(){return validations;},reopen(){workspace.close();workspace=new Workspace(directory);}};
}
const record={title:'一个事件',body:'写下我了解到的事情。',kind:'note',status:'adopted',time:'2026年10月2日',placeIds:['place_local']};
const rejects=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('discovery has closed schemas, versioned tools, and no credentials',async t=>{
 const f=await fixture(t),schema=f.service.discovery();
 assert.equal(schema.version,'1');assert.equal(schema.operations.length,9);
 assert(schema.operations.every(item=>item.inputSchema.additionalProperties===false));
 assert(schema.tools.find(tool=>tool.function.name==='create_entry').function.parameters.required.includes('requestId'));
 assert(!schema.tools.find(tool=>tool.function.name==='search_places').function.parameters.properties.requestId);
 schema.operations[0].inputSchema.properties.query.maxLength=1;
 assert.equal(f.service.discovery().operations[0].inputSchema.properties.query.maxLength,200);
});

test('place search exposes all exact ambiguities even when the candidate page is small',async t=>{
 const f=await fixture(t);f.seed('place_other',{name:'长安',kind:'city',coordinates:null,country:'另一国'});
 const response=(await f.run('search_places',{query:'长安',limit:1})).result;
 assert.equal(response.resolution,'ambiguous_exact');assert.equal(response.resolvedPlaceId,null);assert.equal(response.exactMatchCount,2);assert.equal(response.exactMatches.length,2);assert.equal(response.candidates.length,1);
 assert.equal((await f.run('search_places',{query:'长安',country:'另一国'})).result.resolvedPlaceId,'place_other');
 assert.equal((await f.run('search_places',{query:'西安'})).result.resolvedPlaceId,'place_local');
 assert.equal((await f.run('search_places',{query:'长'})).result.resolvedPlaceId,null);
 f.seed('place_legacy',{name:'另一旧城',kind:'city',coordinates:null,aliases:[{name:'古称'},null]});
 assert.equal((await f.run('search_places',{query:'古称'})).result.resolvedPlaceId,'place_legacy');
});

test('time parsing keeps uncertainty and rejects impossible dates and injected nested fields',async t=>{
 const f=await fixture(t);
 const unknown=(await f.run('parse_time',{time:'建城之后的某一天'})).result;
 assert.equal(unknown.time.originalText,'建城之后的某一天');assert.equal(unknown.indexed,false);assert.equal(unknown.time.earliest,null);
 const precise=(await f.run('parse_time',{time:'公元前221年'})).result;
 assert.equal(precise.time.earliest.era,'BCE');assert.equal(precise.indexed,true);
 await rejects(f.run('parse_time',{time:'2026年2月30日'}),'INVALID_INPUT');
 await rejects(f.run('parse_time',{time:'2027至2026'}),'INVALID_INPUT');
 await rejects(f.run('parse_time',{time:{...parseTime('2026'),sql:'DROP TABLE objects'}}),'INVALID_INPUT');
});

test('closed input schemas reject unknown operations, fields, omissions, and duplicate places without writes',async t=>{
 const f=await fixture(t),before=f.workspace.stats().sequence;
 await rejects(f.run('create_entry',{...record,apiKey:'do not accept'},'bad1'),'INVALID_INPUT');
 await rejects(f.run('create_entry',{...record,placeIds:['place_local','place_local']},'bad2'),'INVALID_INPUT');
 await rejects(f.run('create_entry',record),'INVALID_INPUT');
 await rejects(f.service.execute({version:'2',operation:'create_entry',arguments:record,requestId:'bad3'}),'INVALID_INPUT');
 await rejects(f.service.execute({version:'1',operation:'commit',arguments:{},requestId:'bad4'}),'INVALID_INPUT');
 await rejects(f.service.execute({version:'1',operation:'parse_time',arguments:{time:'2026'},extra:true}),'INVALID_INPUT');
 assert.equal(f.workspace.stats().sequence,before);
});

test('durable request replay returns original entry after place deletion, later edits, and process restart',async t=>{
 const f=await fixture(t),saved=await f.run('create_entry',record,'event-once');
 const entry=saved.result.objects[0];assert.equal(entry.data.placeRefs[0].originalName,'长安');
 await f.run('delete_place',{id:'place_local',expectedRevision:1},'remove-place');
 await f.run('update_entry',{id:entry.id,expectedRevision:1,patch:{body:'后来修改过的记录'}},'edit-entry');
 const count=f.validations,sequence=f.workspace.stats().sequence;
 f.reopen();
 const replay=await f.run('create_entry',record,'event-once');
 assert.equal(replay.replayed,true);assert.deepEqual(replay.result,saved.result);assert.equal(f.validations,count);assert.equal(f.workspace.stats().sequence,sequence);
 assert.equal(f.workspace.get(entry.id).data.body,'后来修改过的记录');
 const receipt=f.workspace.getCommit('operation:v1:event-once');receipt.objects[0].data.body='mutated returned copy';
 assert.equal(f.workspace.getCommit('operation:v1:event-once').objects[0].data.body,record.body);
 assert.equal(f.workspace.getCommit('not-committed'),null);
});

test('request reuse conflicts across different payloads and targets before checking live state',async t=>{
 const f=await fixture(t);await f.run('create_entry',record,'one-key');
 await rejects(f.run('create_entry',{...record,body:'另一个指令'},'one-key'),'IDEMPOTENCY_CONFLICT');
 await rejects(f.run('delete_place',{id:'place_not_existing',expectedRevision:1},'one-key'),'IDEMPOTENCY_CONFLICT');
});

test('updates reject stale revisions and retain citations, metadata and original prediction identity',async t=>{
 const f=await fixture(t),created=(await f.run('create_entry',{...record,kind:'prediction',time:'2090',conditions:'在这个条件下'},'prediction')).result.objects[0];
 const first=await f.run('update_entry',{id:created.id,expectedRevision:1,patch:{body:'修改预言依据'}},'update-prediction');
 assert.equal(first.result.objects[0].data.initialPredictionRevision,1);assert.equal(first.result.objects[0].data.conditions,'在这个条件下');
 assert.equal(first.result.objects[0].data.kind,'prediction');assert.deepEqual(first.result.objects[0].data.citations,[]);
 await rejects(f.run('update_entry',{id:created.id,expectedRevision:1,patch:{body:'覆盖后续编辑'}},'stale-edit'),'VERSION_CONFLICT');
 await rejects(f.run('update_entry',{id:created.id,expectedRevision:2,patch:{kind:'note'}},'change-identity'),'INVALID_INPUT');
 await f.run('update_entry',{id:created.id,expectedRevision:2,patch:{title:'后来的标题'}},'later-edit');
 assert.deepEqual((await f.run('update_entry',{id:created.id,expectedRevision:1,patch:{body:'修改预言依据'}},'update-prediction')).result,first.result);
});

test('custom place deletion keeps record and history, clears exploration, and restore restores exploration',async t=>{
 const f=await fixture(t),entry=(await f.run('create_entry',record,'event')).result.objects[0];
 const projection=()=>projectAtlas(f.workspace.list({objectType:'entry'}).items,f.workspace.list({objectType:'place'}).items,parseTime('2026'));
 assert.deepEqual(projection().explored,['place_local']);
 const removed=await f.run('delete_place',{id:'place_local',expectedRevision:1},'delete');
 assert(removed.result.objects[0].deletedAt);assert.deepEqual(f.workspace.get(entry.id),entry);assert.deepEqual(projection().explored,[]);
 assert.equal(f.workspace.history('place_local').length,2);
 await rejects(f.run('restore_place',{id:'place_local',expectedRevision:1},'restore-stale'),'VERSION_CONFLICT');
 const restored=await f.run('restore_place',{id:'place_local',expectedRevision:2},'restore');
 assert.equal(restored.result.objects[0].deletedAt,null);assert.deepEqual(projection().explored,['place_local']);
 assert.deepEqual((await f.run('delete_place',{id:'place_local',expectedRevision:1},'delete')).result,removed.result);
 f.seed('place_ne_reserved',{name:'内置城',kind:'city',coordinates:[1,1],userCreated:true});
 await rejects(f.run('delete_place',{id:'place_ne_reserved',expectedRevision:1},'delete-built-in'),'OPERATION_NOT_ALLOWED');
});

test('inbox permits incomplete context without lighting the map, adopted requires resolved time and place',async t=>{
 const f=await fixture(t);
 await rejects(f.run('create_entry',{...record,time:'某一天'},'unknown-adopted'),'TIME_UNRESOLVED');
 await rejects(f.run('create_entry',{...record,placeIds:[]},'missing-place'),'PLACE_REQUIRED');
 const inbox=(await f.run('create_entry',{...record,status:'inbox',time:'某一天',placeIds:[]},'inbox')).result.objects[0];
 assert.equal(inbox.data.occurrenceTime.originalText,'某一天');
 assert.deepEqual(projectAtlas([inbox],[f.place],parseTime('2026')).explored,[]);
 await f.run('delete_place',{id:'place_local',expectedRevision:1},'remove');
 await rejects(f.run('create_entry',record,'deleted-ref'),'INVALID_PLACE');
});

test('text-only updates preserve unresolved placement of existing UI-adopted entries',async t=>{
 const f=await fixture(t);
 const existing=f.seed('entry_from_ui',{title:'随手记',body:'原来的正文',kind:'note',status:'adopted',occurrenceTime:null,placeRefs:[],citations:[],conditions:''},'entry');
 const edited=(await f.run('update_entry',{id:existing.id,expectedRevision:1,patch:{body:'只修改正文'}},'ui-text-update')).result.objects[0];
 assert.equal(edited.data.body,'只修改正文');assert.equal(edited.data.status,'adopted');assert.equal(edited.data.occurrenceTime,null);assert.deepEqual(edited.data.placeRefs,[]);
 await rejects(f.run('update_entry',{id:edited.id,expectedRevision:2,patch:{time:null}},'ui-clear-time'),'TIME_UNRESOLVED');
 const located=(await f.run('create_entry',record,'located-entry')).result.objects[0];
 await rejects(f.run('update_entry',{id:located.id,expectedRevision:1,patch:{placeIds:[]}},'clear-place'),'PLACE_REQUIRED');
 await rejects(f.run('update_entry',{id:located.id,expectedRevision:1,patch:{time:null}},'clear-time'),'TIME_UNRESOLVED');
 assert.equal(f.workspace.get(located.id).revision,1);
});

test('create_place validates coordinates, marks custom data, and replays after deletion',async t=>{
 const f=await fixture(t),args={name:'河畔',kind:'naturalFeature',coordinates:[112,32]};
 await rejects(f.run('create_place',{...args,coordinates:[181,32]},'bad-location'),'INVALID_INPUT');
 const saved=await f.run('create_place',args,'new-place'),place=saved.result.objects[0];assert.equal(place.data.userCreated,true);
 await f.run('delete_place',{id:place.id,expectedRevision:1},'new-delete');
 assert.deepEqual((await f.run('create_place',args,'new-place')).result,saved.result);
});

test('record reads are bounded and support exact version and body continuation',async t=>{
 const f=await fixture(t),saved=(await f.run('create_entry',{...record,body:'a'.repeat(30000)},'long')).result.objects[0];
 const page=(await f.run('get_object',{id:saved.id,bodyLimit:5000})).result;assert.equal(page.object.data.body.length,5000);assert.equal(page.body.nextOffset,5000);assert.equal(page.body.total,30000);
 const tail=(await f.run('get_object',{id:saved.id,revision:1,bodyOffset:25000,bodyLimit:5000})).result;assert.equal(tail.body.nextOffset,null);
 const list=(await f.run('list_entries',{limit:1})).result;assert.equal(list.items.length,1);assert.equal(list.items[0].data.body,undefined);
 await rejects(f.run('list_entries',{limit:101}),'INVALID_INPUT');
});

test('HTTP operations require the active local session and return usable schemas, commits, and errors',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'chronicle-operations-http-'));
 const app=await createAppServer({dataDir:directory,seed:false});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await app.close();assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(directory,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const schema=await(await fetch(`${base}/api/operations/schema`)).json();assert.equal(schema.operations.length,9);
 const connection=await(await fetch(`${base}/api/operations/connection`)).json();assert(connection.mcpServers.chronicle.args[0].endsWith('agent-mcp.mjs'));
 const {token}=await(await fetch(`${base}/api/session`)).json();
 const call=(body,headers={})=>fetch(`${base}/api/operations`,{method:'POST',headers:{'Content-Type':'application/json','X-Chronicle-Token':token,...headers},body:JSON.stringify(body)});
 const envelope={version:'1',operation:'create_place',requestId:'http-place',arguments:{name:'独立测试城',kind:'city',coordinates:[120,30]}};
 assert.equal((await call(envelope,{'X-Chronicle-Token':'wrong'})).status,403);
 assert.equal((await call(envelope,{'Origin':'https://untrusted.invalid'})).status,400);
 const response=await call(envelope);assert.equal(response.status,200);const first=await response.json();assert.equal(first.result.objects[0].revision,1);
 const again=await(await call(envelope)).json();assert.equal(again.replayed,true);assert.deepEqual(again.result,first.result);
 const invalid=await call({...envelope,requestId:'http-unknown',arguments:{...envelope.arguments,arbitraryCommand:'something'}});assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.details.reason,'UNKNOWN_FIELD');
 const unresolved=await call({version:'1',operation:'create_entry',requestId:'http-unresolved',arguments:{...record,time:'未知年代',placeIds:[first.result.objects[0].id]}});assert.equal(unresolved.status,422);assert.equal((await unresolved.json()).error.code,'TIME_UNRESOLVED');
});
