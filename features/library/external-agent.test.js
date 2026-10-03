import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {PassThrough} from 'node:stream';
import {createAppServer} from '../../apps/server/main.js';
import {runMcp} from '../../scripts/agent-mcp.mjs';

async function setup(t){const dir=mkdtempSync(path.join(tmpdir(),'library-external-')),app=await createAppServer({dataDir:dir,seed:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();assert.ok(dir.startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true});});const base='http://127.0.0.1:'+app.server.address().port;let n=0;const call=(name,args={})=>app.library.call(name,{...args,...(app.library.tools.find(t=>t.name===name).readOnly?{}:{requestId:'external-'+(++n)})});return{app,base,call};}

test('Reader commands survive stale heartbeats, confirm only after browser ACK, and report failures truthfully',async t=>{
 const{call}=await setup(t),book=await call('library_import',{body:'第一页。'+ '甲'.repeat(6500)+'\n\n第二页。'}),sessionId='reader-external';const initial={sessionId,publicationId:book.publicationId,renditionId:book.renditionId,pageIndex:0};
 await call('reader_sync',initial);const command=await call('reader_navigate',{sessionId,pageIndex:1});assert.equal(command.commandStatus,'pending');
 const stale=await call('reader_sync',initial);assert.equal(stale.pageIndex,1);assert.equal(stale.commandStatus,'pending');
 const applied=await call('reader_sync',{...initial,pageIndex:1,ackCommand:command.command});assert.equal(applied.commandStatus,'applied');assert.equal(applied.appliedCommand,command.command);
 const second=await call('reader_navigate',{sessionId,pageIndex:0});const oldAck=await call('reader_sync',{...initial,pageIndex:1,ackCommand:command.command});assert.equal(oldAck.command,second.command);assert.equal(oldAck.pageIndex,0);assert.equal(oldAck.commandStatus,'pending');
 const failed=await call('reader_sync',{...initial,pageIndex:1,ackCommand:second.command,commandError:'笔记保存失败'});assert.equal(failed.commandStatus,'failed');assert.equal(failed.pageIndex,1);assert.equal(failed.commandError,'笔记保存失败');
 await call('reader_navigate',{sessionId,pageIndex:0});await call('reader_sync',{sessionId,closedBook:true});await assert.rejects(call('reader_get_context',{sessionId}),e=>e.code==='READER_UNAVAILABLE');
});

test('External API publishes matching OpenAPI tools, a readable guide and protected direct tool calls',async t=>{
 const{app,base}=await setup(t),schema=await(await fetch(base+'/api/library/schema')).json(),openapi=await(await fetch(base+'/api/library/openapi.json')).json(),guide=await(await fetch(base+'/api/library/agent-guide')).text();
 assert.match(guide,/commandStatus=applied/);assert.match(schema.instructions,/library_agent_guide/);assert.equal(openapi.openapi,'3.1.0');assert.equal(Object.keys(openapi.paths).length,schema.tools.length);assert.equal(schema.operations.some(t=>t.name==='reader_sync'),false);
 for(const t of schema.operations)assert.deepEqual(openapi.paths['/api/library/tools/'+t.name].post.requestBody.content['application/json'].schema,t.inputSchema);
 const route=base+'/api/library/tools/library_agent_guide';assert.equal((await fetch(route,{method:'POST',body:'{}'})).status,403);const{token}=await(await fetch(base+'/api/session')).json();const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-Chronicle-Token':token},body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).markdown,guide);assert.equal(app.readingChat,undefined);
});

test('MCP publishes guide resources and prompts, excludes browser heartbeat and delivers original image bytes',async t=>{
 const{base,app,call}=await setup(t);const pixels=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X0O8AAAAASUVORK5CYII=','base64');const asset=app.workspace.putAttachment(pixels,{name:'page.png',mime:'image/png'});
 // Borrow only metadata validation via a fake HTTP asset result; all other MCP requests use the real app.
 const input=new PassThrough(),output=new PassThrough();let raw='';output.on('data',b=>raw+=b);const fetchImpl=async(url,options)=>{if(url===base+'/api/library'&&JSON.parse(options.body).operation==='book_get_asset')return new Response(JSON.stringify({...asset,url:'/api/attachments/'+asset.id}),{headers:{'content-type':'application/json'}});return fetch(url,options);};
 const running=runMcp({input,output,base,scope:'library',fetchImpl});const messages=[{id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'external-test',version:'1'}}},{method:'notifications/initialized'},{id:2,method:'resources/list'},{id:3,method:'resources/read',params:{uri:'chronicle-library://guide'}},{id:4,method:'prompts/list'},{id:5,method:'prompts/get',params:{name:'library-assist',arguments:{request:'解释当前页',sessionId:'reader-test'}}},{id:6,method:'tools/list'},{id:7,method:'tools/call',params:{name:'book_get_asset',arguments:{publicationId:'fixture',attachmentId:asset.id}}},{id:8,method:'resources/read',params:{uri:'file:///not-allowed'}}];for(const m of messages)input.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');input.end();await running;const replies=new Map(raw.trim().split('\n').map(JSON.parse).map(r=>[r.id,r]));
 assert.ok(replies.get(1).result.capabilities.prompts);assert.equal(replies.get(2).result.resources[0].uri,'chronicle-library://guide');assert.match(replies.get(3).result.contents[0].text,/Unicode code point/);assert.equal(replies.get(4).result.prompts[0].name,'library-assist');assert.match(replies.get(5).result.messages[0].content.text,/reader-test/);assert.equal(replies.get(6).result.tools.some(t=>t.name==='reader_sync'),false);assert.equal(replies.get(7).result.content[1].type,'image');assert.equal(replies.get(7).result.content[1].data,pixels.toString('base64'));assert.equal(replies.get(8).error.code,-32002);
});
