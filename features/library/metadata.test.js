import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Workspace} from '../../packages/workspace/index.js';
import {fromText,pythonPath,readEmbeddedMetadata} from './conversion.js';
import {detectBookMetadata,applyBookMetadata} from './metadata.js';
import {createLibraryService} from './service.js';
import JSZip from './vendor/jszip.cjs';

const cover=fromText('表示学习的原理\n或几何的数学理论\nAlice Smith∗\n, UC Berkeley\nBob Green, University of Somewhere\n本书仅供阅读。\n版权 2025 Alice Smith, Bob Green\nISBN: 978-0-306-40615-7');
test('Cover extraction separates title, subtitle, authors, affiliations and copyright',()=>{
 const d=detectBookMetadata(cover,{filename:'book-main.pdf'}).fields;
 assert.equal(d.title.value,'表示学习的原理');assert.equal(d.subtitle.value,'或几何的数学理论');assert.equal(d.author.value,'Alice Smith、Bob Green');assert.equal(d.isbn.value,'9780306406157');assert.equal(d.author.pageIndex,0);assert.equal(d.publishedDate,undefined);assert.equal(d.publisher,undefined);
});
test('File metadata wins, bogus software authors and invalid ISBNs stay empty',()=>{
 const d=detectBookMetadata(cover,{embedded:{source:'pdf-metadata',title:'文件内书名',author:'正确作者',CreationDate:'D:20251001',isbn:'9780000000000'}}).fields;
 assert.equal(d.title.value,'文件内书名');assert.equal(d.author.value,'正确作者');assert.equal(d.author.confidence,'high');assert.equal(d.publishedDate,undefined);assert.equal(d.isbn.value,'9780306406157');
 const empty=detectBookMetadata({blocks:[]},{embedded:{title:'Untitled',author:'Microsoft Word',CreationDate:'2020'},filename:'扫描件.pdf'}).fields;assert.equal(empty.title.value,'扫描件');assert.equal(empty.title.source,'filename');assert.equal(empty.author,undefined);
});
test('OCR-style labelled metadata and manual overrides remain explicit and stable',()=>{
 const doc=fromText('书名：山川\n作者：张三、李四\n出版社：示例出版社\n出版日期：2024-05\n语言：zh-CN\nISBN：0-306-40615-2'),d=detectBookMetadata(doc);
 assert.equal(d.fields.title.value,'山川');assert.equal(d.fields.publisher.value,'示例出版社');assert.equal(d.fields.isbn.value,'0306406152');
 const applied=applyBookMetadata({title:'我的书名',author:'',metadataOverrides:{title:true,author:true}},d);assert.equal(applied.title,'我的书名');assert.equal(applied.author,'');assert.equal(applied.publisher,'示例出版社');
 const legacy=applyBookMetadata({title:'scan.pdf',originalName:'scan.pdf'},d);assert.equal(legacy.title,'山川');
});
async function setup(t){const directory=await mkdtemp(path.join(tmpdir(),'chronicle-metadata-')),w=new Workspace(directory),service=createLibraryService({getWorkspace:()=>w});let n=0;t.after(async()=>{await service.close();w.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));await rm(directory,{recursive:true,force:true});});return{directory,w,call:(name,args={})=>service.call(name,args),write:(name,args)=>service.call(name,{...args,requestId:'metadata-'+ ++n})};}
async function finished(w,id){for(let i=0;i<300;i++){const job=w.get(id);if(['complete','partial','failed'].includes(job.data.status))return job;await new Promise(r=>setTimeout(r,20));}throw new Error('Conversion timeout');}
test('Automatic metadata, correction, repeat detection, export and addition use one rendition',async t=>{
 const{w,write}=await setup(t),started=await write('conversion_start',{body:'# 自动书名\n\n作者：张三\n\n出版社：甲出版社',format:'markdown'}),j=await finished(w,started.jobId);
 assert.equal(j.data.title,'自动书名');assert.equal(j.data.author,'张三');assert.equal(j.data.publisher,'甲出版社');assert.equal(w.list({objectType:'publication'}).total,0);
 const structureId=j.data.rendition.structureAttachmentId,assetCount=w.listAttachments().length;
 await write('conversion_update_metadata',{id:j.id,expectedRevision:j.revision,title:'核对后的书名',author:'',language:'zh-CN'});
 await assert.rejects(write('conversion_detect_metadata',{id:j.id,expectedRevision:j.revision}),e=>e.code==='VERSION_CONFLICT');
 let current=w.get(j.id);await write('conversion_detect_metadata',{id:j.id,expectedRevision:current.revision});current=w.get(j.id);
 assert.equal(current.data.title,'核对后的书名');assert.equal(current.data.author,'');assert.equal(current.data.publisher,'甲出版社');assert.equal(current.data.rendition.structureAttachmentId,structureId);assert.equal(w.listAttachments().length,assetCount);
 const exported=await write('conversion_export',{id:j.id}),zip=await JSZip.loadAsync(w.getAttachment(exported.attachmentId).buffer),manifest=JSON.parse(await zip.file('manifest.json').async('string'));assert.equal(manifest.publication.title,'核对后的书名');assert.equal(manifest.publication.publisher,'甲出版社');
 const added=await write('conversion_add',{id:j.id,expectedRevision:current.revision});assert.equal(w.get(added.publicationId).data.language,'zh-CN');assert.equal(w.get(w.get(added.publicationId).data.sourceId).data.publisher,'甲出版社');
 const imported=await write('library_import',{attachmentId:exported.attachmentId});assert.equal(w.get(imported.publicationId).data.metadataOverrides.author,true);assert.equal(w.get(imported.publicationId).data.publisher,'甲出版社');
});
test('A title entered before conversion always wins over detected book title',async t=>{
 const{w,write}=await setup(t),r=await write('conversion_start',{title:'读者的名称',body:'# 实际书名\n\n作者：李四',format:'markdown'}),j=await finished(w,r.jobId);assert.equal(j.data.title,'读者的名称');assert.equal(j.data.metadataDetection.fields.title.value,'实际书名');assert.equal(j.data.author,'李四');
});
test('EPUB Dublin Core metadata includes multiple authors and excludes translators',async t=>{
 const{w,write}=await setup(t),zip=new JSZip();zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');zip.file('book.opf','<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>电子书名</dc:title><dc:creator id="a">张三</dc:creator><dc:creator id="b">李四</dc:creator><dc:creator id="c">译者</dc:creator><meta refines="#c" property="role">trl</meta><dc:publisher>乙出版社</dc:publisher><dc:date>2023-02</dc:date><dc:language>zh</dc:language><dc:identifier>urn:isbn:9780306406157</dc:identifier></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');zip.file('chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>内容。</p></body></html>');
 const asset=w.putAttachment(await zip.generateAsync({type:'nodebuffer'}),{name:'random.epub'}),r=await write('conversion_start',{attachmentId:asset.id}),j=await finished(w,r.jobId);assert.equal(j.data.status,'complete',j.data.error);assert.equal(j.data.title,'电子书名');assert.equal(j.data.author,'张三、李四');assert.equal(j.data.publisher,'乙出版社');assert.equal(j.data.isbn,'9780306406157');assert.equal(j.data.publishedDate,'2023-02');assert.equal(j.data.language,'zh');
});
test('PDF metadata can be read from an extensionless stored file without re-rendering pages',async t=>{
 const{w,directory}=await setup(t),filename=path.join(directory,'source.pdf');await promisify(execFile)(pythonPath(),['-c','from reportlab.pdfgen.canvas import Canvas; import sys; c=Canvas(sys.argv[1]); c.setTitle("Embedded title"); c.setAuthor("Alice Smith; Bob Green"); c.drawString(50,700,"A book"); c.save()',filename],{windowsHide:true});
 const asset=await w.putAttachmentFile(filename,{name:'source.pdf'}),metadata=await readEmbeddedMetadata(await w.getAttachmentFile(asset.id));assert.equal(metadata.title,'Embedded title');assert.equal(metadata.author,'Alice Smith; Bob Green');assert.equal(metadata.publishedDate,undefined);
});
