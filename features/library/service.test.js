import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {createLibraryService} from './service.js';
import {quoteTarget,toCodePoint,toUtf16,resolveTargets,MARKS} from './model.js';
import JSZip from './vendor/jszip.cjs';
import {validateReadingZip} from './package.js';
const setup=async t=>{const dir=mkdtempSync(path.join(tmpdir(),'chronicle-library-test-')),w=new Workspace(dir),service=createLibraryService({getWorkspace:()=>w});t.after(async()=>{await service.close();w.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep));rmSync(resolved,{recursive:true,force:true});});let n=0;return{w,service,read:(name,a)=>service.call(name,a),write:(name,a)=>service.call(name,{...a,requestId:'test-'+ ++n})};};

test('Unicode anchors and formulas are stable through storage, export, revisions, undo and recovery',async t=>{
 const {w,read,write,service}=await setup(t);
 const imported=await write('library_import',{title:'测试书',body:'# 第一章\n\n阅读📚时，要区分原文与批注。\n\n$$x^2+y^2=z^2$$',format:'markdown'});
 const book={publicationId:imported.publicationId,renditionId:imported.renditionId};
 const content=await read('book_read',book);const b=content.items.find(b=>b.text.startsWith('阅读'));assert.ok(b);assert.equal(content.items.find(b=>b.kind==='formula').text,'\uFFFC');
 assert.equal(toCodePoint(b.text,7),6);assert.equal(toUtf16(b.text,6),7);
 const target=quoteTarget(b,6,13);assert.equal(target.exact,'区分原文与批注');
 await assert.rejects(write('annotation_create',{...book,targets:[{...target,start:0}],mark:{type:'highlight',color:'#ffcc00'}}),/不一致/);
 const created=[];for(const type of Object.keys(MARKS))created.push(await write('annotation_create',{...book,targets:[target],mark:{type,color:'#cc8844'},body:'理解应与原文分开'}));
 assert.equal((await read('annotation_list',book)).total,10);
 const exported=await read('annotation_export',book);assert.equal(exported.items.length,10);assert.equal(exported.items[0].target[0].selector[0].start,6);
 const last=created.at(-1),an=await read('annotation_get',{id:last.annotationId});
 const updated=await write('annotation_update',{id:an.id,expectedRevision:an.revision,body:'新批注'});
 await assert.rejects(write('annotation_update',{id:an.id,expectedRevision:an.revision,body:'过时更新'}),e=>e.code==='VERSION_CONFLICT');
 const undo=await write('operation_undo',{id:updated.operationId,expectedRevision:1});assert.equal((await read('annotation_get',{id:an.id})).data.body,'理解应与原文分开');
 await write('operation_redo',{id:updated.operationId,expectedRevision:undo.targetOperationRevision});assert.equal((await read('annotation_get',{id:an.id})).data.body,'新批注');
 const p=w.get(book.publicationId);const corrected=await write('book_correct',{id:p.id,expectedRevision:p.revision,corrections:[{blockId:b.id,text:b.text+'校对。'}]});assert.notEqual(corrected.renditionId,book.renditionId);
 assert.equal((await read('annotation_read_context',{id:an.id})).context[0].block.text,b.text);
 const pack=await write('book_export',{publicationId:p.id});const restored=await write('library_import',{attachmentId:pack.attachmentId});assert.notEqual(restored.publicationId,p.id);assert.equal((await read('annotation_list',{publicationId:restored.publicationId})).total,10);
 const idem={title:'幂等书',body:'不会重复。',requestId:'same-request'};const first=await service.call('library_import',idem);const again=await service.call('library_import',idem);assert.equal(first.publicationId,again.publicationId);assert.equal(again.replayed,true);await assert.rejects(service.call('library_import',{...idem,body:'changed'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
});

test('Ambiguous relocation, code point boundaries, invalid regions and mutation bypass are rejected',async t=>{
 const {w,read,write}=await setup(t);const imported=await write('library_import',{body:'同一句。\n\n同一句。'}),p=w.get(imported.publicationId),b=(await read('book_read',{publicationId:p.id})).items[0];
 const an=await write('annotation_create',{publicationId:p.id,renditionId:imported.renditionId,targets:[quoteTarget(b,0,3)],mark:{type:'circle',color:'#ff0000'}});
 const result=await read('annotation_reanchor_preview',{id:an.annotationId,renditionId:imported.renditionId});assert.equal(result.segments[0].status,'ambiguous');
 await assert.rejects(write('annotation_create',{publicationId:p.id,renditionId:imported.renditionId,targets:[{kind:'region',pageIndex:0,rect:[0.9,0.9,0.3,0.3]}],mark:{type:'rectangle',color:'#ff0000'}}),/超出/);
 const {validateCommit}=await import('../../apps/server/validate.js');await assert.rejects(validateCommit(w,{changes:[{id:'anno_bad',objectType:'annotation',expectedRevision:0,data:{}}]}),/领域操作/);
 assert.throws(()=>resolveTargets({blocks:[{id:'b',text:'👨‍👩‍👦'}]},[{kind:'text',blockId:'b',start:0,end:1,exact:'👨'}]),/组合字符/);
});

test('Library correction never overwrites separately edited or reused source material',async t=>{
 const{w,write,read}=await setup(t);const imported=await write('library_import',{body:'原文。'}),p=w.get(imported.publicationId),source=w.get(p.data.sourceId),b=(await read('book_read',{publicationId:p.id})).items[0];
 w.commit({requestId:'edited-source',changes:[{...source,expectedRevision:source.revision,data:{...source.data,body:'读者另行编辑的材料。'}}]});
 await write('book_correct',{id:p.id,expectedRevision:p.revision,corrections:[{blockId:b.id,text:'校对后的书内原文。'}]});assert.equal(w.get(source.id).data.body,'读者另行编辑的材料。');
 const reused=await write('library_import',{sourceId:source.id}),p2=w.get(reused.publicationId),b2=(await read('book_read',{publicationId:p2.id})).items[0];await write('book_correct',{id:p2.id,expectedRevision:p2.revision,corrections:[{blockId:b2.id,text:'另一本书的校对。'}]});assert.equal(w.get(source.id).data.body,'读者另行编辑的材料。');
});

test('Reading packages reject duplicate directory names before loading assets',async()=>{
 const zip=new JSZip();zip.file('manifest.json','{}');zip.file('assets/a','a');zip.file('assets/b','b');const bytes=await zip.generateAsync({type:'nodebuffer'});assert.doesNotThrow(()=>validateReadingZip(bytes));
 const bad=Buffer.from(bytes);let at=0;while((at=bad.indexOf(Buffer.from('assets/b'),at))>=0){Buffer.from('assets/a').copy(bad,at);at+=8;}assert.throws(()=>validateReadingZip(bad),/重复/);
});

test('Region moves keep identity and body, support consecutive undo, reject stale writes and text-anchor moves',async t=>{
 const {read,write}=await setup(t),book=await write('library_import',{body:'保留准确原文。'}),target={kind:'region',pageIndex:0,rect:[.1,.1,.2,.1]};
 const created=await write('annotation_create',{publicationId:book.publicationId,renditionId:book.renditionId,targets:[target],body:'我的笔记',mark:{type:'triangle',color:'#ffcc00'}});
 const first=await write('annotation_update',{id:created.annotationId,expectedRevision:1,targets:[{...target,rect:[.3,.3,.2,.1]}]});
 const second=await write('annotation_update',{id:created.annotationId,expectedRevision:2,targets:[{...target,rect:[.3,.3,.4,.2]}]});
 assert.equal((await read('annotation_get',{id:created.annotationId})).data.body,'我的笔记');
 await assert.rejects(write('annotation_update',{id:created.annotationId,expectedRevision:1,targets:[target]}),e=>e.code==='VERSION_CONFLICT');
 const u2=await write('operation_undo',{id:second.operationId,expectedRevision:1});
 const u1=await write('operation_undo',{id:first.operationId,expectedRevision:1});
 assert.deepEqual((await read('annotation_get',{id:created.annotationId})).data.targets,[target]);
 await write('operation_redo',{id:first.operationId,expectedRevision:u1.targetOperationRevision});
 await write('operation_redo',{id:second.operationId,expectedRevision:u2.targetOperationRevision});
 const latest=await read('annotation_get',{id:created.annotationId});assert.deepEqual(latest.data.targets[0].rect,[.3,.3,.4,.2]);
 await assert.rejects(write('annotation_update',{id:latest.id,expectedRevision:latest.revision,targets:[{...target,rect:[.9,.9,.3,.3]}]}),/超出/);
 const b=(await read('book_read',{publicationId:book.publicationId})).items[0],text=await write('annotation_create',{publicationId:book.publicationId,renditionId:book.renditionId,targets:[quoteTarget(b,0,2)],mark:{type:'underline',color:'#ffcc00'}});
 await assert.rejects(write('annotation_update',{id:text.annotationId,expectedRevision:1,targets:[target]}),/文字批注保持原文绑定/);
});

test('Companion context follows the specified reader and preserves selected quotes and recognition state',async t=>{
 const {read,write}=await setup(t),book=await write('library_import',{title:'伴读测试',body:'精确的伴读原文。'}),b=(await read('book_read',{publicationId:book.publicationId})).items[0],target=quoteTarget(b,0,2);
 await write('reader_sync',{sessionId:'reader-test',publicationId:book.publicationId,renditionId:book.renditionId,pageIndex:0,targets:[target]});
 const created=await write('annotation_create',{publicationId:book.publicationId,renditionId:book.renditionId,targets:[target],body:'解释',mark:{type:'highlight',color:'#ffcc00'}});
 const ctx=await read('reader_get_context',{sessionId:'reader-test',limit:1});assert.equal(ctx.publication.title,'伴读测试');assert.equal(ctx.selected[0].target.exact,'精确');assert.equal(ctx.selected[0].block.recognition.status,b.recognition.status);assert.equal(ctx.annotations.items[0].id,created.annotationId);assert.equal(ctx.content.items[0].id,b.id);
 await write('reader_sync',{sessionId:'reader-test',closedBook:true});await assert.rejects(read('reader_get_context',{sessionId:'reader-test'}),e=>e.code==='READER_UNAVAILABLE');
});
