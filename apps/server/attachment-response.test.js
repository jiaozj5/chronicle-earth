import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {sendAttachment,verifiedAttachment} from './attachment-response.js';

test('large-book attachments support PDF byte ranges, HEAD, suffixes and unsatisfiable ranges',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'library-range-')),file=path.join(dir,'book.pdf'),data=Buffer.from('0123456789abcdef');await writeFile(file,data);
 const server=http.createServer((req,res)=>sendAttachment(req,res,{path:file,size:data.length,mime:'application/pdf',name:'book.pdf'}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  for(const [range,status,body,contentRange]of [['bytes=2-5',206,'2345','bytes 2-5/16'],['bytes=14-',206,'ef','bytes 14-15/16'],['bytes=-3',206,'def','bytes 13-15/16'],['bytes=99-100',416,'','bytes */16'],['bytes=8-3',416,'','bytes */16'],['bytes=-0',416,'','bytes */16']]){
   const r=await fetch(url,{headers:{Range:range}});assert.equal(r.status,status);assert.equal(r.headers.get('content-range'),contentRange);assert.equal(await r.text(),body);
  }
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.headers.get('accept-ranges'),'bytes');assert.equal(head.headers.get('content-length'),'16');assert.equal(await head.text(),'');
  const full=await fetch(url);assert.equal(full.status,200);assert.equal(await full.text(),data.toString());
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('range verification is reused only while the underlying attachment is unchanged',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'library-verified-')),file=path.join(dir,'book');await writeFile(file,'original');let verifications=0;
 const workspace={async getAttachmentFile(){verifications++;return{path:file,size:8};}};
 try{await Promise.all([verifiedAttachment(workspace,'one'),verifiedAttachment(workspace,'one')]);assert.equal(verifications,1);await verifiedAttachment(workspace,'one');assert.equal(verifications,1);await writeFile(file,'changed file');await verifiedAttachment(workspace,'one');assert.equal(verifications,2);}finally{await rm(dir,{recursive:true,force:true});}
});
