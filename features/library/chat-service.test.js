import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {DomainError} from '../../packages/contracts/index.js';
import {createLibraryService} from './service.js';
import {createReadingChat} from './chat-service.js';
import {quoteTarget} from './model.js';
import {createAppServer} from '../../apps/server/main.js';

async function setup(t,generate){const dir=mkdtempSync(path.join(tmpdir(),'chronicle-chat-')),w=new Workspace(dir),library=createLibraryService({getWorkspace:()=>w}),provider={generate,status:async()=>({connected:true,provider:'test'})},chat=createReadingChat({getWorkspace:()=>w,library,provider});t.after(async()=>{chat.close();await library.close();w.close();assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true});});const book=await library.call('library_import',{body:'选中的原文📚。'+ '甲'.repeat(6100)+'\n\n第二页的内容。',requestId:'chat-book'}),first=(await library.call('book_read',{publicationId:book.publicationId,pageIndex:0})).items[0];const a={publicationId:book.publicationId,renditionId:book.renditionId,pageIndex:0,targets:[quoteTarget(first,0,8)],body:'这句话是什么意思？',includeImage:false,threadId:'reading_chat_test',requestId:'request_chat_first'};return{w,library,chat,a};}

test('Reading chat streams a pinned selection, persists history, isolates books and replays without charging twice',async t=>{
 const prompts=[];const{w,library,chat,a}=await setup(t,async o=>{const prompt=JSON.parse(o.prompt.slice(o.prompt.indexOf('{')));prompts.push(prompt);o.onText('测试');o.onText('测试回答。');return{body:'测试回答。',model:'test'};});
 await library.call('library_import',{body:'不属于这本书的私密材料',requestId:'other-book'});
 const events=[],first=await chat.send(a,{onEvent:e=>events.push(e)});assert.equal(first.message.data.status,'complete');assert.deepEqual(events.map(e=>e.type),['started','text','text','done']);assert.equal(prompts[0].reading.selectedText,a.targets[0].exact);assert.equal(prompts[0].reading.page,1);assert.equal(JSON.stringify(prompts).includes('私密材料'),false);
 const replay=await chat.send(a);assert.equal(replay.replayed,true);assert.equal(prompts.length,1);await assert.rejects(chat.send({...a,body:'不同问题'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 await chat.send({...a,pageIndex:1,targets:[],body:'继续解释第二页',requestId:'request_chat_second'});assert.equal(prompts[1].reading.page,2);assert.equal(prompts[1].history.length,2);assert.equal(prompts[1].history[0].page,1);
 const history=chat.history({publicationId:a.publicationId});assert.equal(history.messages.length,4);assert.equal(history.messages[0].data.context.pageIndex,0);assert.equal(history.threads.length,1);assert.equal(w.list({objectType:'annotation'}).total,0);
 const before=w.list({objectType:'message'}).total;await assert.rejects(chat.send({...a,requestId:'request_bad_anchor',targets:[{...a.targets[0],exact:'错引'}]}));assert.equal(w.list({objectType:'message'}).total,before);
});

test('Stop and retry preserve partial text and the original question context even after the reader turns pages',async t=>{
 let calls=0,retried;const{chat,a}=await setup(t,async o=>{if(!calls++){o.onText('已收到的半句话');throw new DomainError('CANCELLED','已停止生成');}retried=JSON.parse(o.prompt.slice(o.prompt.indexOf('{')));return{body:'重试后的测试回答'};});
 const stopped=await chat.send(a);assert.equal(stopped.message.data.body,'已收到的半句话');assert.equal(stopped.message.data.status,'interrupted');
 await chat.send({...a,requestId:'request_retry_answer',retryOf:stopped.message.id,pageIndex:1,targets:[],body:'重试'});assert.equal(retried.question,a.body);assert.equal(retried.reading.page,1);assert.equal(retried.reading.selectedText,a.targets[0].exact);assert.equal(chat.history({publicationId:a.publicationId}).messages.filter(m=>m.data.role==='user').length,1);
});

test('Concurrent requests are blocked and cancellation reaches the provider',async t=>{
 let started;const ready=new Promise(r=>started=r);const{chat,a}=await setup(t,o=>new Promise((resolve,reject)=>{started();o.signal.addEventListener('abort',()=>reject(new DomainError('CANCELLED','已停止生成')),{once:true});}));
 const pending=chat.send(a);await ready;assert.equal(chat.active,true);await assert.rejects(chat.send({...a,requestId:'request_concurrent'}),e=>e.code==='DISCUSSION_BUSY');assert.equal(chat.cancel(a).cancelled,true);const stopped=await pending;assert.equal(stopped.message.data.status,'interrupted');assert.equal(chat.active,false);
});

test('Retired in-app chat returns an explicit removal response and never calls a model',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'chronicle-chat-http-'));const app=await createAppServer({dataDir:dir,seed:false,readingProvider:{status:async()=>({connected:true}),generate:async o=>{o.onText('测试流式内容');return{body:'测试流式内容'};}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,session=await(await fetch(base+'/api/session')).json(),book=await app.library.call('library_import',{body:'HTTP 伴读原文',requestId:'http-chat-book'}),payload={publicationId:book.publicationId,renditionId:book.renditionId,pageIndex:0,targets:[],includeImage:false,body:'请解释',requestId:'request_http_chat',threadId:'reading_chat_http'};
 const denied=await fetch(base+'/api/library/chat/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(denied.status,403);
 const headers={'Content-Type':'application/json','X-Chronicle-Token':session.token},reply=await fetch(base+'/api/library/chat/send',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(reply.status,410);assert.equal((await reply.json()).error.code,'FEATURE_REMOVED');assert.equal(app.workspace.list({objectType:'message'}).total,0);assert.equal(app.readingChat,undefined);
});
