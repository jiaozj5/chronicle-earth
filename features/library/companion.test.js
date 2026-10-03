import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAppServer} from '../../apps/server/main.js';
import {runMcp} from '../../scripts/agent-mcp.mjs';
import {codexConfig,companionPrompt} from './companion.js';

test('MCP companion discovers tools, reads live context and writes an anchored note over HTTP',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'chronicle-companion-')),app=await createAppServer({dataDir:dir,seed:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true});});
 const book=await app.library.call('library_import',{title:'MCP 测试',body:'伴读需要准确的原文。',requestId:'book'}),b=(await app.library.call('book_read',{publicationId:book.publicationId})).items[0],target={kind:'text',blockId:b.id,start:0,end:2,exact:'伴读'};
 await app.library.call('reader_sync',{sessionId:'reader-mcp',publicationId:book.publicationId,renditionId:book.renditionId,pageIndex:0,targets:[target],requestId:'sync'});
 const base='http://127.0.0.1:'+app.server.address().port,input=new PassThrough(),output=new PassThrough();let raw='';output.on('data',b=>raw+=b);
 const running=runMcp({input,output,base,scope:'library'});
 for(const message of [
  {id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},
  {method:'notifications/initialized'},
  {id:2,method:'tools/list'},
  {id:3,method:'tools/call',params:{name:'reader_get_context',arguments:{sessionId:'reader-mcp'}}},
  {id:4,method:'tools/call',params:{name:'annotation_create',arguments:{publicationId:book.publicationId,renditionId:book.renditionId,targets:[target],body:'Agent 的解释',author:'伴读 Agent',mark:{type:'underline',color:'#446655'},requestId:'agent-note'}}}
 ])input.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');input.end();await running;
 const replies=raw.trim().split('\n').map(JSON.parse);assert.ok(replies.find(r=>r.id===2).result.tools.some(t=>t.name==='reader_get_context'));
 assert.equal(replies.find(r=>r.id===3).result.structuredContent.selected[0].target.exact,'伴读');
 const created=replies.find(r=>r.id===4).result;assert.equal(created.isError,false);const context=await app.library.call('annotation_read_context',{id:created.structuredContent.annotationId});assert.equal(context.annotation.data.body,'Agent 的解释');assert.equal(context.context[0].block.id,b.id);
 const connection=await(await fetch(base+'/api/library/connection')).json();assert.match(codexConfig(connection),/\[mcp_servers.chronicle-library\]/);assert.match(companionPrompt('reader-mcp'),/reader_get_context/);
});
