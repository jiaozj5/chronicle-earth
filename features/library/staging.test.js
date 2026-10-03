import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {createLibraryService} from './service.js';
import JSZip from './vendor/jszip.cjs';
import {open,rm} from 'node:fs/promises';
import {validateReadingZip} from './package.js';

async function setup(t){const directory=mkdtempSync(path.join(tmpdir(),'chronicle-conversion-test-')),w=new Workspace(directory);let service=createLibraryService({getWorkspace:()=>w}),i=0;t.after(async()=>{await service.close();w.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));rmSync(directory,{recursive:true,force:true});});return{w,call:(name,args={})=>service.call(name,args),write:(name,args)=>service.call(name,{...args,requestId:'stage-'+ ++i}),async restart(){await service.close();service=createLibraryService({getWorkspace:()=>w});}};}
async function finish(w,id){for(let i=0;i<100;i++){const j=w.get(id);if(['complete','partial','failed','cancelled'].includes(j.data.status))return j;await new Promise(r=>setTimeout(r,10));}throw new Error('Conversion timed out');}

test('Conversion produces a preview and portable file before any publication or source exists',async t=>{
 const{w,call,write,restart}=await setup(t),started=await write('conversion_start',{title:'转换检查',body:'# 第一章\n\n阅读📚与公式 $E=mc^2$。',format:'markdown'});assert.equal(w.list({objectType:'publication'}).total,0);assert.equal(w.list({objectType:'source'}).total,0);
 const job=await finish(w,started.jobId);assert.equal(job.data.status,'complete',job.data.error);await restart();
 const preview=await call('conversion_preview',{id:job.id});assert.equal(preview.items[0].text,'第一章');assert.ok(preview.items.some(b=>b.runs.some(r=>r.atom==='formula')));assert.equal(preview.pageCount,1);
 const list=await call('conversion_list');assert.equal(list.items[0].id,job.id);assert.equal(list.items[0].data.attachmentIds,undefined);assert.equal(list.items[0].data.rendition,undefined);
 const result=await write('conversion_export',{id:job.id}),zip=await JSZip.loadAsync(w.getAttachment(result.attachmentId).buffer),manifest=JSON.parse(await zip.file('manifest.json').async('string'));assert.equal(manifest.profile,'chronicle-reading-1');assert.equal(manifest.publication.title,'转换检查');assert.deepEqual(manifest.annotations,[]);assert.equal(w.list({objectType:'publication'}).total,0);assert.equal(w.list({objectType:'source'}).total,0);
 const added=await write('conversion_add',{id:job.id,expectedRevision:job.revision,title:'检查后加入',shelf:'数学'}),publication=w.get(added.publicationId);assert.equal(publication.data.title,'检查后加入');assert.equal(publication.data.currentRendition,job.data.rendition.id);assert.equal(publication.data.renditions[0].structureAttachmentId,job.data.rendition.structureAttachmentId);assert.equal(w.list({objectType:'publication'}).total,1);assert.equal(w.list({objectType:'source'}).total,1);assert.equal(w.list({objectType:'importJob'}).total,1);
 const duplicate=await write('conversion_add',{id:job.id,expectedRevision:job.revision});assert.equal(duplicate.publicationId,publication.id);assert.equal(duplicate.alreadyAdded,true);assert.equal(w.list({objectType:'publication'}).total,1);
 const fromFile=await write('library_import',{attachmentId:result.attachmentId});assert.equal((await call('book_read',{publicationId:fromFile.publicationId})).items[0].text,'第一章');
});

test('Queued conversion cancellation creates no book; a retry still waits for explicit addition',async t=>{
 const{w,write,call}=await setup(t),a=await write('conversion_start',{body:'第一份。'}),b=await write('conversion_start',{body:'第二份。'}),before=w.get(b.jobId);await write('import_cancel',{id:before.id,expectedRevision:before.revision});assert.equal((await finish(w,a.jobId)).data.status,'complete');assert.equal((await finish(w,b.jobId)).data.status,'cancelled');assert.equal(w.list({objectType:'publication'}).total,0);
 await assert.rejects(write('conversion_add',{id:b.jobId,expectedRevision:2}),e=>e.code==='RENDITION_UNAVAILABLE');const current=w.get(b.jobId),retry=await write('import_retry',{id:b.jobId,expectedRevision:current.revision});assert.equal((await finish(w,retry.jobId)).data.status,'complete');assert.equal(w.list({objectType:'publication'}).total,0);assert.equal((await call('conversion_list')).total,3);
});

test('Reading packages above the former 256 MiB ceiling stream to disk and round-trip',async t=>{
 const{w,write,call}=await setup(t),started=await write('conversion_start',{body:'大文件转换结果。'}),job=await finish(w,started.jobId);
 const filename=path.join(w.directory,'large-fixture'),handle=await open(filename,'wx');try{await handle.truncate(257*1024*1024);}finally{await handle.close();}
 const large=await w.putAttachmentFile(filename,{name:'large.bin'});await rm(filename);w.commit({requestId:'large-result',changes:[{id:job.id,objectType:job.objectType,expectedRevision:job.revision,data:{...job.data,attachmentIds:[...job.data.attachmentIds,large.id]}}]});
 const result=await write('conversion_export',{id:job.id}),buffer=w.getAttachment(result.attachmentId).buffer;assert.doesNotThrow(()=>validateReadingZip(buffer));
 const zip=await JSZip.loadAsync(buffer),manifest=JSON.parse(await zip.file('manifest.json').async('string'));assert.ok(manifest.files.reduce((n,f)=>n+f.size,0)>256*1024*1024);assert.equal(manifest.files.find(f=>f.id===large.id).sha256,large.sha256);
 const imported=await write('library_import',{attachmentId:result.attachmentId});assert.equal((await call('book_read',{publicationId:imported.publicationId})).items[0].text,'大文件转换结果。');
});
