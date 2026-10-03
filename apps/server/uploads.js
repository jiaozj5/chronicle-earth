import {mkdir,open,rm,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assert,DomainError} from '../../packages/contracts/index.js';

export const MAX_UPLOAD_BYTES=512*1024*1024;
export const UPLOAD_CHUNK_BYTES=1024*1024;
const TTL=30*60*1000;
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');

// Each request holds at most one chunk in memory. Acknowledgements can be retried
// without appending the same bytes twice or creating a second attachment.
export async function createUploads(directory,getWorkspace){
 await mkdir(directory,{recursive:true});
 for(const name of await readdir(directory))if(/^[a-f0-9-]{36}\.partial$/.test(name)){
  const file=path.join(directory,name);if(Date.now()-(await stat(file)).mtimeMs>TTL)await rm(file,{force:true});
 }
 const sessions=new Map();
 const remove=async s=>{await rm(s.file,{force:true});sessions.delete(s.id);};
 const cleanup=setInterval(()=>{for(const s of sessions.values())if(!s.busy&&Date.now()-s.touched>TTL)remove(s).catch(()=>{});},60000);cleanup.unref();
 function info(s){return{id:s.id,offset:s.offset,size:s.size,chunkBytes:UPLOAD_CHUNK_BYTES,...(s.result?{attachment:s.result}:{})};}
 function session(id){const s=sessions.get(id);assert(s&&s.workspace===getWorkspace(),'上传已失效，请重新选择文件上传。','NOT_FOUND');s.touched=Date.now();return s;}
 async function locked(s,action){assert(!s.busy,'上一段文件仍在保存，请稍后重试。','STORAGE_BUSY');s.busy=true;try{return await action();}finally{s.busy=false;s.touched=Date.now();}}
 return{
  get active(){return [...sessions.values()].filter(s=>!s.result).length;},
  async start(a){
   assert(typeof a.id==='string'&&/^[a-f0-9-]{36}$/.test(a.id),'上传标识无效。');
   assert(typeof a.name==='string'&&a.name.length>0&&a.name.length<=1000&&typeof a.mime==='string'&&a.mime.length<=250,'文件信息无效。');
   assert(Number.isSafeInteger(a.size)&&a.size>0,'请选择非空文件。');
   assert(a.size<=MAX_UPLOAD_BYTES,'单个文件最多 512 MiB，请拆分后上传。','CAPACITY_EXCEEDED');
   if(sessions.has(a.id)){const s=session(a.id);assert(s.name===a.name&&s.mime===a.mime&&s.size===a.size,'上传标识已用于其他文件。','IDEMPOTENCY_CONFLICT');return info(s);}
   assert(sessions.size<100,'上传任务过多，请稍后重试。','STORAGE_BUSY');
   const s={...a,workspace:getWorkspace(),file:path.join(directory,a.id+'.partial'),offset:0,touched:Date.now(),busy:true};sessions.set(s.id,s);
   try{const handle=await open(s.file,'wx');await handle.close();s.busy=false;return info(s);}catch(e){sessions.delete(s.id);throw e;}
  },
  async chunk(id,offset,req){
   const s=session(id);return locked(s,async()=>{
    assert(!s.result&&Number.isSafeInteger(offset)&&offset>=0,'上传位置无效。');
    const parts=[];let size=0;
    for await(const b of req){size+=b.length;if(size>UPLOAD_CHUNK_BYTES)throw new DomainError('CAPACITY_EXCEEDED','文件分段过大。');parts.push(b);}
    const buffer=Buffer.concat(parts);assert(size>0&&offset+size<=s.size,'文件分段大小不符。');
    const hash=digest(buffer);
    if(offset!==s.offset){assert(s.last?.offset===offset&&s.last.size===size&&s.last.hash===hash,'上传位置已变化，请重试。','VERSION_CONFLICT');return info(s);}
    const handle=await open(s.file,'r+');
    try{let written=0;while(written<size){const r=await handle.write(buffer,written,size-written,offset+written);assert(r.bytesWritten>0,'无法保存文件。','STORAGE_FAILED');written+=r.bytesWritten;}}finally{await handle.close();}
    s.last={offset,size,hash};s.offset+=size;return info(s);
   });
  },
  async finish(id){const s=session(id);return locked(s,async()=>{if(s.result)return s.result;assert(s.offset===s.size,'文件尚未上传完整。');s.result=await s.workspace.putAttachmentFile(s.file,{name:s.name,mime:s.mime});await rm(s.file,{force:true});return s.result;});},
  async cancel(id){const s=sessions.get(id);if(s)await locked(s,()=>remove(s));return{cancelled:true};},
  async close(){clearInterval(cleanup);for(const s of sessions.values())await remove(s);}
 };
}
