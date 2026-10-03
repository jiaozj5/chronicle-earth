import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCodexProvider} from './codex-provider.js';

function fakeProvider(t,{complete=true}={}){const directory=mkdtempSync(path.join(tmpdir(),'chronicle-codex-')),requests=[],clients=[];t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));rmSync(directory,{recursive:true,force:true});});const provider=createCodexProvider({directory,findExecutable:async()=>'/test/codex',createRpc:()=>{const rpc={listeners:new Set(),closed:false,initialize:async()=>{},close(){this.closed=true;},async request(method,params){requests.push({method,params});if(method==='account/read')return{account:{type:'chatgpt',email:'not-exposed@example.test'}};if(method==='config/read')return{config:{mcp_servers:{privateConnector:{enabled:true}}}};if(method==='thread/start')return{thread:{id:'ephemeral'},model:'test-model'};if(method==='turn/start'){queueMicrotask(()=>{for(const fn of this.listeners){fn({method:'item/agentMessage/delta',params:{threadId:'ephemeral',itemId:'answer',delta:'你好'}});fn({method:'item/completed',params:{threadId:'ephemeral',item:{type:'agentMessage',id:'answer',text:'你好。'}}});if(complete)fn({method:'turn/completed',params:{threadId:'ephemeral',turn:{status:'completed'}}});}});return{turn:{id:'turn_test'}};}return{};}};clients.push(rpc);return rpc;}});return{provider,requests,clients};}

test('Codex bridge uses managed login, ephemeral conversation and streamed public text, then closes its process',async t=>{
 const{provider,requests,clients}=fakeProvider(t),status=await provider.status();assert.equal(status.connected,true);assert.equal(JSON.stringify(status).includes('@'),false);
 const streamed=[],result=await provider.generate({instructions:'伴读',prompt:'问题',imagePath:'/test/page.png',onText:s=>streamed.push(s)});assert.deepEqual(streamed,['你好','你好。']);assert.equal(result.body,'你好。');
 const thread=requests.find(r=>r.method==='thread/start').params;assert.equal(thread.ephemeral,true);assert.deepEqual(thread.environments,[]);assert.equal(thread.sandbox,'read-only');assert.equal(thread.config.mcp_servers.privateConnector.enabled,false);assert.equal(thread.config['features.shell_tool'],false);
 assert.equal(requests.find(r=>r.method==='turn/start').params.input[1].type,'localImage');assert.ok(clients.every(c=>c.closed));assert.equal(requests.some(r=>/login|logout|write/.test(r.method)),false);
});
test('Codex timeout is an error, not a completed answer, and the child is closed',async t=>{const{provider,clients}=fakeProvider(t,{complete:false});await assert.rejects(provider.generate({instructions:'伴读',prompt:'问题',timeoutMs:10}),e=>e.code==='CODEX_TIMEOUT');assert.ok(clients.every(c=>c.closed));});

test('completed turn replaces abandoned retry fragments and commentary with the final answer',async t=>{
 const{provider,clients}=fakeProvider(t,{complete:false});const output=[];
 const resultPromise=provider.generate({instructions:'伴读',prompt:'问题',onText:s=>output.push(s)});
 while(!clients[0]?.listeners.size)await new Promise(r=>setImmediate(r));
 const rpc=clients[0],emit=(method,params)=>{for(const fn of rpc.listeners)fn({method,params:{threadId:'ephemeral',...params}});};
 emit('item/agentMessage/delta',{itemId:'abandoned',delta:'重复的未完成片段'});
 emit('item/completed',{item:{type:'agentMessage',id:'status',text:'正在阅读',phase:'commentary'}});
 emit('turn/completed',{turn:{status:'completed',items:[{type:'agentMessage',id:'status',text:'正在阅读',phase:'commentary'},{type:'agentMessage',id:'final',text:'最后的准确回答',phase:'final_answer'}]}});
 assert.equal((await resultPromise).body,'最后的准确回答');assert.equal(output.at(-1),'最后的准确回答');assert.ok(rpc.closed);
});

test('stop during connection closes the process without starting inference',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'chronicle-cancel-'));t.after(()=>{assert.ok(directory.startsWith(path.resolve(tmpdir())+path.sep));rmSync(directory,{recursive:true,force:true});});
 const controller=new AbortController();let rejectInit,closed=false;
 const provider=createCodexProvider({directory,findExecutable:async()=>'/test/codex',createRpc:()=>({initialize:()=>new Promise((resolve,reject)=>{rejectInit=reject;queueMicrotask(()=>controller.abort());}),close(){closed=true;rejectInit?.(new Error('closed'));},request(){assert.fail('No model request during cancellation');}})});
 await assert.rejects(provider.generate({instructions:'伴读',prompt:'问题',signal:controller.signal}),e=>e.code==='CANCELLED');assert.equal(closed,true);
});

test('Codex discovers account models and forwards model, effort and host tools on the actual turn',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'chronicle-dynamic-'));t.after(()=>{assert.ok(directory.startsWith(path.resolve(tmpdir())+path.sep));rmSync(directory,{recursive:true,force:true});});const requests=[];let called;
 const provider=createCodexProvider({directory,findExecutable:async()=>'/test/codex',createRpc:()=>({
  listeners:new Set(),initialize:async()=>{},close(){},
  async request(method,params){
   requests.push({method,params});
   if(method==='model/list')return{data:[{model:'model-a',displayName:'A',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high',inputModalities:['text']}],nextCursor:null};
   if(method==='account/read')return{account:{type:'chatgpt'}};
   if(method==='config/read')return{config:{}};
   if(method==='thread/start')return{thread:{id:'thread_dynamic'},model:params.model};
   if(method==='turn/start'){
    queueMicrotask(async()=>{const result=await this.toolHandler({threadId:'thread_dynamic',tool:'book_search',arguments:{query:'慢读'},callId:'call_dynamic'});assert.equal(result.success,true);for(const fn of this.listeners)fn({method:'turn/completed',params:{threadId:'thread_dynamic',turn:{status:'completed',items:[{type:'agentMessage',id:'final',text:'已找到原文。',phase:'final_answer'}]}}});});
    return{turn:{id:'turn_dynamic'}};
   }
  }
 })});
 const models=await provider.models();assert.equal(models[0].id,'model-a');assert.equal(models[0].vision,false);
 const result=await provider.generate({model:'model-a',effort:'high',instructions:'伴读',prompt:'搜索',tools:[{name:'book_search',description:'搜索',inputSchema:{type:'object'}}],callTool:async(...args)=>{called=args;return{success:true,result:{page:2}};}});
 assert.equal(result.model,'model-a');assert.equal(called[0],'book_search');assert.equal(requests.find(r=>r.method==='thread/start').params.dynamicTools[0].type,'function');assert.equal(requests.find(r=>r.method==='turn/start').params.effort,'high');
});
