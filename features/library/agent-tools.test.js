import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {DomainError} from '../../packages/contracts/index.js';
import {createLibraryService} from './service.js';
import {readingTools} from './agent-tools.js';
import {createReadingChat} from './chat-service.js';
import {quoteTarget} from './model.js';
async function fixture(t){const directory=mkdtempSync(path.join(tmpdir(),'reading-agent-')),workspace=new Workspace(directory),library=createLibraryService({getWorkspace:()=>workspace});t.after(async()=>{await library.close();workspace.close();assert.ok(directory.startsWith(path.resolve(tmpdir())+path.sep));rmSync(directory,{recursive:true,force:true});});const book=await library.call('library_import',{body:'慢读是为了理解。\n\n批注保留疑问。',requestId:'agent-book-test'});const block=(await library.call('book_read',{publicationId:book.publicationId,pageIndex:0})).items[0],args={targets:[quoteTarget(block,0,4)],mark:{type:'underline',color:'#657744'},body:'保留问题'};return{workspace,library,...book,args};}
test('agent tools bind book, validate anchors and versions, persist receipts, and deduplicate retries',async t=>{
 const f=await fixture(t),options={...f,questionId:'question_test_agent'},agent=readingTools(options);assert.ok(agent.definitions.length>8);assert.equal(agent.definitions.some(t=>t.name==='library_remove'),false);
 const first=await agent.call('annotation_create',f.args,'call_1');assert.equal(first.success,true);assert.ok(first.result.annotationId);const again=await readingTools(options).call('annotation_create',f.args,'new_call_id');assert.equal(again.result.annotationId,first.result.annotationId);assert.equal(f.workspace.list({objectType:'annotation'}).total,1);
 const invalid=await agent.call('annotation_create',{...f.args,publicationId:'another_book'},'outside');assert.equal(invalid.success,false);
 const other=await f.library.call('library_import',{body:'另一本书',requestId:'agent-second-book'});const cross=await readingTools({...options,publicationId:other.publicationId,renditionId:other.renditionId}).call('annotation_get',{id:first.result.annotationId},'cross');assert.equal(cross.error.code,'OPERATION_NOT_ALLOWED');
 const stale=await agent.call('annotation_update',{id:first.result.annotationId,expectedRevision:999,body:'改写'},'stale');assert.equal(stale.error.code,'VERSION_CONFLICT');
});
test('reader tools cannot operate a window that has switched books',async t=>{const f=await fixture(t),sessionId='reader_agent_test';await f.library.call('reader_sync',{sessionId,publicationId:f.publicationId,renditionId:f.renditionId,pageIndex:0,requestId:'sync_agent_test'});const agent=readingTools({...f,sessionId,questionId:'question_agent_window'});assert.equal((await agent.call('reader_navigate',{pageIndex:0},'nav')).success,true);await f.library.call('reader_sync',{sessionId,closedBook:true,requestId:'close_agent_window'});assert.equal((await agent.call('reader_navigate',{pageIndex:0},'nav2')).error.code,'READER_UNAVAILABLE');});
test('chat records actual tool actions durably and retries include completed actions without duplicate notes',async t=>{
 const f=await fixture(t);let attempts=0;const provider={status:async()=>({connected:true}),generate:async o=>{assert.ok(o.tools.some(t=>t.name==='annotation_create'));const result=await o.callTool('annotation_create',f.args,'save_'+attempts);assert.equal(result.success,true);if(!attempts++)throw new DomainError('CANCELLED','已停止生成');assert.match(o.prompt,/previousActions/);assert.match(o.prompt,/annotationId/);return{body:'已保存。'};}};
 const chat=createReadingChat({getWorkspace:()=>f.workspace,library:f.library,provider}),a={publicationId:f.publicationId,renditionId:f.renditionId,pageIndex:0,targets:[],includeImage:false,body:'给这段做批注',threadId:'reading_chat_agent',requestId:'agent_request_first'};
 const first=await chat.send(a);assert.equal(first.message.data.status,'interrupted');assert.equal(first.message.data.actions[0].status,'complete');
 const retry=await chat.send({...a,requestId:'agent_request_retry',retryOf:first.message.id});assert.equal(retry.message.data.status,'complete');assert.equal(f.workspace.list({objectType:'annotation'}).total,1);
});
