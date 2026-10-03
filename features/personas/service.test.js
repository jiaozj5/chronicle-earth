import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Workspace} from '../../packages/workspace/index.js';
import {createChange,refOf} from '../../packages/contracts/index.js';
import {normalizeEndpoint,savePersona,startDiscussion,sendMessage,handleRequest,parseResponse,callProvider,sourceCoverage} from './service.js';

// All providers below are explicit deterministic protocol fixtures, never evidence of model quality.
async function fixture(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'chronicle-personas-'));const workspace=new Workspace(directory);
 t.after(async()=>{await workspace.close();assert.ok(directory.startsWith(path.join(os.tmpdir(),'chronicle-personas-')));await rm(directory,{recursive:true,force:true});});
 const source=(id,title,body,parseStatus='ready')=>createChange('source',{title,body,format:'text',author:'合成测试作者',attachmentIds:[],parseStatus,citations:[]},id);
 await workspace.commit({requestId:'fixture_sources',changes:[source('source_one','合成材料甲','河流使运输更加方便。城市依赖交换。'),source('source_two','合成材料乙','需要比较不同地区的条件。'),source('source_unparsed','未解析材料','不能被提供的隐藏文字','unparsed'),source('source_private','无关私人来源','PRIVATE_SECRET_SHOULD_NOT_SEND'),createChange('entry',{title:'选中观点',body:'城市增长还可能受制度影响。',kind:'note',status:'inbox',placeRefs:[],occurrenceTime:null,citations:[]},'entry_context'),createChange('entry',{title:'私人无关记录',body:'PRIVATE_ENTRY_SECRET',kind:'note',status:'inbox',placeRefs:[],occurrenceTime:null,citations:[]},'entry_private')]});
 const persona=(await savePersona(workspace,{requestId:'fixture_persona',data:{name:'测试人物甲',style:'简洁',interpretation:'明确区分推演',sourceIds:['source_one','source_two','source_unparsed']}})).persona;
 const discussion=(await startDiscussion(workspace,{personaId:persona.id,requestId:'fixture_discussion',contextRefs:[refOf(await workspace.get('entry_context'))]})).discussion;
 return{workspace,persona,discussion};
}
const settings={endpoint:'http://127.0.0.1:9999/v1',model:'protocol-fixture',apiKey:'fixture-only-not-a-real-secret'};
const content=(segments)=>JSON.stringify({segments});
const provider=(text,inspect)=>async(url,options)=>{inspect?.(url,options);return new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});};
const answer=content([{kind:'interpretation',text:'应同时考察交通与制度。'}]);

test('provider endpoint accepts root, /v1 and complete path without duplication',()=>{
 assert.equal(normalizeEndpoint('https://example.test'),'https://example.test/v1/chat/completions');
 assert.equal(normalizeEndpoint('https://example.test/v1/'),'https://example.test/v1/chat/completions');
 assert.equal(normalizeEndpoint('https://example.test/custom/chat/completions'),'https://example.test/custom/chat/completions');
 assert.throws(()=>normalizeEndpoint('file:///x'));assert.throws(()=>normalizeEndpoint('https://user:pass@example.test'));
});
test('A01 persona editing preserves original sources; new/save/start replay protect all payload fields',async t=>{
 const {workspace,persona,discussion}=await fixture(t);const before=await workspace.get('source_one');
 const updated=await savePersona(workspace,{id:persona.id,revision:persona.revision,requestId:'edit_persona',data:{...persona.data,style:'多问前提',interpretation:'我的新诠释'}});
 assert.equal(updated.persona.data.style,'多问前提');assert.deepEqual(await workspace.get('source_one'),before);
 const again=await savePersona(workspace,{requestId:'fixture_persona',data:{name:'测试人物甲',style:'简洁',interpretation:'明确区分推演',sourceIds:['source_one','source_two','source_unparsed']}});assert.equal(again.persona.id,persona.id);
 await assert.rejects(savePersona(workspace,{requestId:'fixture_persona',data:{name:'不同名字',sourceIds:[]}}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const replay=await startDiscussion(workspace,{personaId:persona.id,requestId:'fixture_discussion',contextRefs:[refOf(await workspace.get('entry_context'))]});assert.equal(replay.discussion.id,discussion.id);assert.equal(replay.discussion.data.personaRef.revision,1);
 await assert.rejects(startDiscussion(workspace,{personaId:persona.id,requestId:'fixture_discussion',contextRefs:[]}),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('A02 source coverage separates ready, unparsed and unavailable material',async t=>{
 const {workspace}=await fixture(t);const c=await sourceCoverage(workspace,['source_one','source_unparsed','missing_source']);assert.deepEqual(c.map(s=>s.ready),[true,false,false]);assert.equal(c[0].revision,1);assert.equal(c[2].revision,null);
});
test('A03/A04 actual SQLite retrieval freezes sources, context and persona; private data never sent',async t=>{
 const {workspace,discussion,persona}=await fixture(t);const old=await workspace.get('source_one');await workspace.commit({requestId:'update_source',changes:[{id:old.id,objectType:old.objectType,expectedRevision:1,data:{...old.data,body:'新版有完全不同的内容。'}}]});
 await savePersona(workspace,{id:persona.id,revision:1,requestId:'update_style',data:{...persona.data,style:'THIS_NEW_STYLE_MUST_NOT_SEND'}});
 let sent;const output=content([{kind:'quote',text:'河流使运输更加方便。',sourceId:'source_one',revision:1,locator:{start:0,end:10}},{kind:'inference',text:'也许制度改变了具体作用。'}]);
 const result=await sendMessage(workspace,settings,{discussionId:discussion.id,body:'运输',requestId:'scope_test_turn'},{fetchImpl:provider(output,(url,options)=>{sent=JSON.parse(options.body);assert.equal(options.headers.Authorization,'Bearer '+settings.apiKey);})});
 assert.equal(result.message.data.status,'complete');assert.equal(result.message.data.citations.length,1);assert.equal(result.message.data.citations[0].revision,1);
 const serialized=JSON.stringify(sent);assert.ok(serialized.includes('河流使运输更加方便'));assert.ok(serialized.includes('城市增长还可能受制度影响'));for(const privateText of ['PRIVATE_SECRET','PRIVATE_ENTRY_SECRET','THIS_NEW_STYLE_MUST_NOT_SEND','新版有完全不同','不能被提供的隐藏文字'])assert.ok(!serialized.includes(privateText),privateText);
 assert.equal(result.message.data.contextSnapshot.personaRef.revision,1);assert.equal(result.message.data.contextSnapshot.sourceRefs[0].revision,1);
});
test('A03 citations use shared validator; outside scope, wrong version and fake quotes never shown as original',async t=>{
 const {workspace}=await fixture(t);const result=await parseResponse(content([{kind:'quote',text:'PRIVATE_SECRET_SHOULD_NOT_SEND',sourceId:'source_private',revision:1},{kind:'quote',text:'伪造的原文',sourceId:'source_one',revision:1},{kind:'quote',text:'需要比较不同地区的条件。',sourceId:'source_two',revision:1}]),workspace,[{sourceId:'source_one',revision:1},{sourceId:'source_two',revision:1}]);
 assert.equal(result.citations.length,1);assert.equal(result.warnings.length,2);assert.ok(!result.body.includes('PRIVATE_SECRET'));assert.ok(!result.body.includes('伪造的原文'));assert.equal(result.segments.filter(s=>s.kind==='quote').length,1);
});
test('unconfigured discussion never fabricates a response and does not store phantom messages',async t=>{
 const {workspace,discussion}=await fixture(t);await assert.rejects(sendMessage(workspace,{}, {discussionId:discussion.id,body:'问题',requestId:'unconfigured_turn'}),e=>e.code==='SERVICE_NOT_CONFIGURED');assert.equal((await workspace.list({objectType:'message'})).total,0);
});
test('A05 failure is persisted, retry uses stable original question, complete messages survive and replay is exact',async t=>{
 const {workspace,discussion}=await fixture(t);const input={discussionId:discussion.id,body:'哪些前提？',requestId:'failed_turn_1'};
 const failed=await sendMessage(workspace,settings,input,{fetchImpl:async()=>new Response('',{status:429})});assert.equal(failed.message.data.status,'failed');assert.equal(failed.error.code,'PROVIDER_LIMIT');
 const retried=await sendMessage(workspace,settings,{discussionId:discussion.id,retryOf:failed.message.id,requestId:'retried_turn_1'},{fetchImpl:provider(answer)});assert.equal(retried.message.data.status,'complete');assert.equal(retried.message.data.questionId,failed.message.data.questionId);assert.notEqual(retried.message.id,failed.message.id);
 const first=await sendMessage(workspace,settings,{discussionId:discussion.id,body:'下一问',requestId:'next_turn_123'},{fetchImpl:provider(answer)});
 const replay=await sendMessage(workspace,settings,{discussionId:discussion.id,body:'下一问',requestId:'next_turn_123'},{fetchImpl:()=>{throw Error('must not call twice');}});assert.deepEqual(replay.message,first.message);
 await assert.rejects(sendMessage(workspace,settings,{discussionId:discussion.id,body:'不同问题',requestId:'next_turn_123'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 assert.equal((await workspace.get(retried.message.id)).revision,2);assert.equal((await workspace.list({objectType:'message'})).items.filter(m=>m.data.role==='user').length,2);
 assert.ok(first.message.data.turnOrder>retried.message.data.turnOrder);
});
test('A05 cancellation persists interrupted status and releases discussion for the next turn',async t=>{
 const {workspace,discussion}=await fixture(t);let reached;const started=new Promise(r=>reached=r);
 const pending=sendMessage(workspace,settings,{discussionId:discussion.id,body:'长问题',requestId:'cancel_turn_123'},{fetchImpl:async(url,{signal})=>{reached();return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}});
 await started;const state=await handleRequest('status',{}, {workspace,settings});assert.ok(state.runningDiscussions.includes(discussion.id));await handleRequest('cancel',{discussionId:discussion.id},{workspace,settings});const result=await pending;assert.equal(result.message.data.status,'interrupted');assert.equal(result.message.data.pending,false);assert.equal((await handleRequest('status',{}, {workspace,settings})).runningDiscussions.length,0);
 const next=await sendMessage(workspace,settings,{discussionId:discussion.id,body:'新问题',requestId:'after_cancel_123'},{fetchImpl:provider(answer)});assert.equal(next.message.data.status,'complete');
});
test('A05 provider timeout, invalid output, authentication and network failures remain explicit',async t=>{
 await assert.rejects(callProvider(settings,[],{timeoutMs:15,fetchImpl:async(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort'))))}),e=>e.code==='PROVIDER_TIMEOUT');
 await assert.rejects(callProvider(settings,[],{fetchImpl:async()=>new Response('',{status:401})}),e=>e.code==='PROVIDER_AUTH');
 await assert.rejects(callProvider(settings,[],{fetchImpl:async()=>{throw Error('secret stack');}}),e=>e.code==='PROVIDER_UNAVAILABLE'&&!e.message.includes('secret'));
 const {workspace,discussion}=await fixture(t);const result=await sendMessage(workspace,settings,{discussionId:discussion.id,body:'问题',requestId:'invalid_output_1'},{fetchImpl:provider('not JSON')});assert.equal(result.message.data.status,'failed');assert.equal(result.error.code,'MODEL_OUTPUT_INVALID');assert.equal(result.message.data.body,'');
});
test('real local HTTP transport validates chat/completions protocol using explicit fake provider',async t=>{
 let received;const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received={url:req.url,authorization:req.headers.authorization,body:JSON.parse(raw)};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const result=await callProvider({...settings,endpoint:'http://127.0.0.1:'+server.address().port},[{role:'user',content:'协议检查'}]);assert.equal(result,answer);assert.equal(received.url,'/v1/chat/completions');assert.equal(received.body.stream,false);assert.equal(received.body.model,'protocol-fixture');assert.equal(received.authorization,'Bearer '+settings.apiKey);
});
