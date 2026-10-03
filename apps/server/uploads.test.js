import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createAppServer} from './main.js';
import {api} from '../client/api.js';
import {createUploads,UPLOAD_CHUNK_BYTES} from './uploads.js';
import {Workspace} from '../../packages/workspace/index.js';
import {Readable} from 'node:stream';

test('Large uploads report progress, retry lost acknowledgements, and preserve exact bytes',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'chronicle-upload-')),app=await createAppServer({dataDir:directory,seed:false});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port,originalFetch=globalThis.fetch;
 let lostChunk=false,lostFinish=false;
 globalThis.fetch=async(url,options)=>{
  const response=await originalFetch(new URL(url,base),options);
  if(options?.method==='PUT'&&!lostChunk){lostChunk=true;await response.arrayBuffer();throw new TypeError('Simulated lost chunk receipt');}
  if(String(url).endsWith('/complete')&&!lostFinish){lostFinish=true;await response.arrayBuffer();throw new TypeError('Simulated lost final receipt');}
  return response;
 };
 t.after(async()=>{globalThis.fetch=originalFetch;await app.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));await rm(directory,{recursive:true,force:true});});
 await api.init();const chunk=Buffer.alloc(1024*1024,81),file=new File(Array(65).fill(chunk),'large.pdf',{type:'application/pdf'}),progress=[];
 const asset=await api.upload(file,{onProgress:p=>progress.push(p.completedBytes)});
 assert.equal(asset.size,65*1024*1024);assert.equal(progress[0],0);assert.equal(progress.at(-1),file.size);assert.ok(progress.length>=66);assert.ok(progress.every((n,i)=>!i||n>=progress[i-1]));assert.ok(lostChunk&&lostFinish);
 const expected=createHash('sha256');for(let i=0;i<65;i++)expected.update(chunk);assert.equal(asset.sha256,expected.digest('hex'));assert.equal((await app.workspace.getAttachmentFile(asset.id)).sha256,asset.sha256);assert.equal(app.workspace.listAttachments().length,1);
 assert.equal((await api.upload(file)).id,asset.id);assert.equal(app.workspace.listAttachments().length,1);
 const controller=new AbortController();await assert.rejects(api.upload(new File([chunk,chunk],'cancel.pdf'),{signal:controller.signal,onProgress:p=>{if(p.completedBytes)controller.abort();}}),e=>e.code==='CANCELLED');assert.equal(app.workspace.listAttachments().length,1);
 // Also exercise the exact upload -> staged conversion transition through HTTP.
 const textFile=new File(['# 转换成功\n\n保留公式 $E=mc^2$。'],'real-upload.md'),textAsset=await api.upload(textFile),session=await(await originalFetch(base+'/api/session')).json();
 const headers={'Content-Type':'application/json','X-Chronicle-Token':session.token};
 const call=async(operation,args)=>{const response=await originalFetch(base+'/api/library',{method:'POST',headers,body:JSON.stringify({operation,arguments:args})});assert.equal(response.status,200);return response.json();};
 const started=await call('conversion_start',{attachmentId:textAsset.id,requestId:randomUUID()});let job;
 for(let i=0;i<100;i++){job=app.workspace.get(started.jobId);if(job.data.status==='complete')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(job.data.status,'complete',job.data.error);assert.equal(app.workspace.list({objectType:'publication'}).total,0);assert.equal((await call('conversion_preview',{id:job.id})).items[0].text,'转换成功');
 const invalid=await originalFetch(base+'/api/uploads',{method:'POST',headers,body:JSON.stringify({id:randomUUID(),name:'too-big.pdf',mime:'application/pdf',size:512*1024*1024+1})});assert.equal(invalid.status,413);
 for(let i=0;i<30&&(await readdir(path.join(directory,'transfers','attachment-uploads'))).length;i++)await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(await readdir(path.join(directory,'transfers','attachment-uploads')),[]);
});

test('Incomplete, conflicting and oversized chunks never publish an attachment; failed finalization can retry',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'chronicle-upload-errors-')),w=new Workspace(path.join(directory,'workspace')),uploads=await createUploads(path.join(directory,'uploads'),()=>w);
 t.after(async()=>{await uploads.close();w.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));await rm(directory,{recursive:true,force:true});});
 const uploadId=randomUUID(),input={id:uploadId,size:6,name:'sample.pdf',mime:'application/pdf'};
 await uploads.start(input);await assert.rejects(uploads.start({...input,name:'other.pdf'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 await assert.rejects(uploads.start({...input,id:'../outside'}),e=>e.code==='INVALID_INPUT');
 await assert.rejects(uploads.finish(uploadId),/完整/);assert.equal(w.listAttachments().length,0);
 assert.equal((await uploads.chunk(uploadId,0,Readable.from([Buffer.from('abc')]))).offset,3);
 assert.equal((await uploads.chunk(uploadId,0,Readable.from([Buffer.from('abc')]))).offset,3);
 await assert.rejects(uploads.chunk(uploadId,0,Readable.from([Buffer.from('xyz')])),e=>e.code==='VERSION_CONFLICT');
 await assert.rejects(uploads.chunk(uploadId,3,Readable.from([Buffer.alloc(UPLOAD_CHUNK_BYTES+1)])),e=>e.code==='CAPACITY_EXCEEDED');
 await uploads.chunk(uploadId,3,Readable.from([Buffer.from('def')]));
 const original=w._fault.bind(w);w._fault=stage=>{if(stage==='beforeAttachmentCommit')throw new Error('disk failure');original(stage);};
 await assert.rejects(uploads.finish(uploadId));assert.equal(w.listAttachments().length,0);assert.deepEqual(await readdir(w.attachmentsPath),[]);
 w._fault=original;const asset=await uploads.finish(uploadId);assert.equal(w.getAttachment(asset.id).buffer.toString(),'abcdef');assert.equal((await uploads.finish(uploadId)).id,asset.id);assert.equal(w.listAttachments().length,1);
});
