import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from './vendor/jszip.cjs';
import {createAppServer} from '../../apps/server/main.js';
import {runMcp} from '../../scripts/agent-mcp.mjs';

async function appFor(t){const dir=mkdtempSync(path.join(tmpdir(),'chronicle-library-http-'));const app=await createAppServer({dataDir:dir,seed:false});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true});});return{app,base};}
const until=async fn=>{const start=Date.now();while(Date.now()-start<15000){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out');};

test('MCP discovery and calls use the same persistent reading and annotation service as HTTP',async t=>{
 const{app,base}=await appFor(t),input=new PassThrough(),output=new PassThrough();let rest='',count=0;const replies=new Map();output.on('data',b=>{rest+=b;let nl;while((nl=rest.indexOf('\n'))>=0){const msg=JSON.parse(rest.slice(0,nl));rest=rest.slice(nl+1);replies.set(msg.id,msg);}});
 const done=runMcp({input,output,base,scope:'library'});const rpc=async(method,params)=>{const id=++count;input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');const r=await until(()=>replies.get(id));assert.equal(r.error,undefined,JSON.stringify(r));return r.result;};
 await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'library-test',version:'1'}});input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=await rpc('tools/list',{});assert.ok(tools.tools.length>=35);assert.ok(tools.tools.find(t=>t.name==='annotation_create').inputSchema.required.includes('requestId'));
 const imported=(await rpc('tools/call',{name:'library_import',arguments:{title:'Agent 的书',body:'原文📚可被准确读取。',requestId:'mcp-import'}})).structuredContent;
 const read=(await rpc('tools/call',{name:'book_read',arguments:{publicationId:imported.publicationId}})).structuredContent;assert.equal(read.items[0].text,'原文📚可被准确读取。');
 const an=(await rpc('tools/call',{name:'annotation_create',arguments:{publicationId:imported.publicationId,renditionId:imported.renditionId,targets:[{kind:'text',blockId:read.items[0].id,start:0,end:3,exact:'原文📚'}],mark:{type:'check',color:'#445566'},body:'精确的原文',requestId:'mcp-annotation'}})).structuredContent;
 assert.ok(an.annotationId);const context=(await rpc('tools/call',{name:'annotation_read_context',arguments:{id:an.annotationId}})).structuredContent;assert.equal(context.context[0].target.exact,'原文📚');assert.equal(context.annotation.data.body,'精确的原文');
 const replay=(await rpc('tools/call',{name:'annotation_create',arguments:{publicationId:imported.publicationId,renditionId:imported.renditionId,targets:[{kind:'text',blockId:read.items[0].id,start:0,end:3,exact:'原文📚'}],mark:{type:'check',color:'#445566'},body:'精确的原文',requestId:'mcp-annotation'}})).structuredContent;assert.equal(replay.annotationId,an.annotationId);assert.equal(app.workspace.list({objectType:'annotation'}).total,1);
 const denied=await fetch(base+'/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'library_import',arguments:{body:'should not save',requestId:'bad'}})});assert.equal(denied.status,403);
 input.end();await done;
});

test('EPUB preserves spine order, image bytes, emphasis and MathML while scripts stay inert',async t=>{
 const{app}=await appFor(t);const z=new JSZip();z.file('mimetype','application/epub+zip');z.file('META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>');
 z.file('OEBPS/book.opf','<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="p" href="image.png" media-type="image/png"/></manifest><spine><itemref idref="c"/></spine></package>');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII=','base64');z.file('OEBPS/image.png',png);
 z.file('OEBPS/chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>书</title><script>throw new Error("inert")</script></head><body><h1>第一章</h1><p>阅读<strong>原文</strong>与公式<math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup></math>。</p><p><img src="image.png" alt="原书图"/></p></body></html>');
 const asset=app.workspace.putAttachment(await z.generateAsync({type:'nodebuffer'}),{name:'sample.epub',mime:'application/epub+zip'});
 const imported=await app.library.call('library_import',{attachmentId:asset.id,requestId:'epub-import'});const job=await until(()=>{const j=app.workspace.get(imported.jobId);return ['complete','failed','partial'].includes(j.data.status)?j:null;});assert.equal(job.data.status,'complete',job.data.error);
 const content=await app.library.call('book_read',{publicationId:imported.publicationId});assert.equal(content.items[0].text,'第一章');const paragraph=content.items.find(b=>b.text.startsWith('阅读'));assert.equal(paragraph.text,'阅读原文与公式\uFFFC。');assert.ok(paragraph.runs.find(r=>r.bold));assert.match(paragraph.runs.find(r=>r.atom==='formula').mathml,/<math xmlns=/);const picture=content.items.find(b=>b.runs.some(r=>r.atom==='image'));assert.deepEqual(app.workspace.getAttachment(picture.runs[0].attachmentId).buffer,png);assert.equal(content.items.some(b=>b.text.includes('throw new Error')),false);
});
