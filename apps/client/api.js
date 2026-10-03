import {DomainError,id} from '../../packages/contracts/index.js';
let csrfToken='';
const uploadedFiles=new WeakMap();
async function uploadRequest(path,options,signal){
 for(let attempt=0;;attempt++){
  if(signal?.aborted)throw new DomainError('CANCELLED','上传已取消。');
  const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);
  try{return await request(path,{...options,signal:controller.signal});}
  catch(e){if(signal?.aborted)throw new DomainError('CANCELLED','上传已取消。');if(timedOut)e=new DomainError('SERVICE_UNAVAILABLE','上传超时，请检查本机服务后重试。');if(attempt>=2||!['SERVICE_UNAVAILABLE','STORAGE_BUSY'].includes(e.code))throw e;await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)));}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
}
export async function request(path,options={}){
 const headers=new Headers(options.headers||{});
 if(options.body!==undefined&&!(options.body instanceof Blob)&&!(options.body instanceof ArrayBuffer)){headers.set('Content-Type','application/json');options={...options,body:JSON.stringify(options.body)};}
 if(csrfToken)headers.set('X-Chronicle-Token',csrfToken);
 let response;try{response=await fetch('/api'+path,{...options,headers});}catch(error){if(error.name==='AbortError')throw new DomainError('CANCELLED','操作已取消');throw new DomainError('SERVICE_UNAVAILABLE','本机服务暂时未连接，内容仍留在编辑区。请确认服务已启动。');}
 const contentType=response.headers.get('content-type')||'';
 const payload=contentType.includes('application/json')?await response.json():null;
 if(!response.ok){const e=payload?.error||{};throw new DomainError(e.code||'SERVICE_UNAVAILABLE',e.message||'操作未完成，请重试。',e.details||{});}
 return payload===null?response:payload;
}
function queryString(query){const p=new URLSearchParams();for(const[k,v]of Object.entries(query||{})){if(v!==undefined&&v!==null)p.set(k,typeof v==='object'?JSON.stringify(v):String(v));}return p.toString();}
async function transfer(path,options,onProgress){
 const transferId=globalThis.crypto.randomUUID();let reading=false,finished=false;
 const read=async()=>{if(reading)return;reading=true;try{const progress=await request('/backup/progress/'+transferId);if(!finished)onProgress?.(progress);}catch{}finally{reading=false;}};
 const timer=onProgress?setInterval(read,250):null;
 try{return await request(path+'?'+queryString({transferId}),options);}finally{finished=true;if(timer)clearInterval(timer);}
}
export const api={
 readingChat(action,body={}){return request('/library/chat/'+action,{method:'POST',body});},
 async streamReadingChat(body,{signal,onEvent}={}){const response=await request('/library/chat/send',{method:'POST',body,signal});const reader=response.body.getReader(),decoder=new TextDecoder();let rest='',done=false;try{while(true){const chunk=await reader.read();rest+=decoder.decode(chunk.value||new Uint8Array(),{stream:!chunk.done});let end;while((end=rest.indexOf('\n'))>=0){const line=rest.slice(0,end);rest=rest.slice(end+1);if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='error')throw new DomainError(event.error.code,event.error.message);if(event.type==='done')done=true;onEvent(event);}if(chunk.done)break;}if(!done)throw new DomainError('SERVICE_UNAVAILABLE','连接已中断，问题已保留，可重试。');}finally{reader.releaseLock();}},
 async library(operation,args={}){const result=await request('/library',{method:'POST',body:{operation,arguments:args}});if(args.requestId&&!operation.startsWith('reader_'))window.dispatchEvent(new CustomEvent('workspace-change',{detail:result}));return result;},
 async init(){const r=await request('/session');csrfToken=r.token;return r;},
 list(query){return request('/objects?'+queryString(query));},
 get(objectId,options={}){return request('/objects/'+encodeURIComponent(objectId)+'?'+queryString(options));},
 history(objectId){return request('/objects/'+encodeURIComponent(objectId)+'/history');},
 async commit(changes,requestId=id('request')){const result=await request('/commit',{method:'POST',body:{changes,requestId}});window.dispatchEvent(new CustomEvent('workspace-change',{detail:result}));return result;},
 remove(object){return this.commit([{id:object.id,objectType:object.objectType,expectedRevision:object.revision,data:object.data,deleted:true}]);},
 restore(object){return this.commit([{id:object.id,objectType:object.objectType,expectedRevision:object.revision,data:object.data,deleted:false}]);},
 stats(){return request('/stats');},
 atlas(params={}){return request('/atlas?'+queryString(params));},
 async upload(file,{signal,onProgress}={}){
  if(!file.size)throw new DomainError('INVALID_INPUT','请选择非空文件。');
  if(file.size>512*1024*1024)throw new DomainError('CAPACITY_EXCEEDED','单个文件最多 512 MiB，请拆分后上传。');
  if(uploadedFiles.has(file)){onProgress?.({completedBytes:file.size,totalBytes:file.size});return uploadedFiles.get(file);}
  const uploadId=globalThis.crypto.randomUUID(),route='/uploads/'+uploadId;
  onProgress?.({completedBytes:0,totalBytes:file.size});
  try{
   const state=await uploadRequest('/uploads',{method:'POST',body:{id:uploadId,name:file.name,mime:file.type||'application/octet-stream',size:file.size}},signal);
   for(let offset=state.offset;offset<file.size;){
    const end=Math.min(offset+state.chunkBytes,file.size);
    const next=await uploadRequest(route+'?offset='+offset,{method:'PUT',body:file.slice(offset,end),headers:{'Content-Type':'application/octet-stream'}},signal);
    if(next.offset!==end)throw new DomainError('INVALID_STATE','文件上传位置不符，请重新上传。');
    offset=next.offset;onProgress?.({completedBytes:offset,totalBytes:file.size});
   }
   const asset=await uploadRequest(route+'/complete',{method:'POST',body:{}},signal);uploadedFiles.set(file,asset);return asset;
  }finally{request(route,{method:'DELETE',signal:AbortSignal.timeout(5000)}).catch(()=>{});}
 },
 searchSources(sourceRefs,query,options={}){return request('/source-search',{method:'POST',body:{sourceRefs,query,...options}});},
 personaRequest(path,body={},signal){return request('/personas/'+path.replace(/^\//,''),{method:'POST',body,signal});},
 settings(){return request('/settings');},
 saveSettings(body){return request('/settings',{method:'POST',body});},
 async adopt(body){const result=await request('/adopt',{method:'POST',body});window.dispatchEvent(new CustomEvent('workspace-change',{detail:result}));return result;},
 async undoAdoption(id){const result=await request('/adopt/'+encodeURIComponent(id)+'/undo',{method:'POST',body:{requestId:globalThis.crypto.randomUUID()}});window.dispatchEvent(new CustomEvent('workspace-change',{detail:result}));return result;},
 exportBackup(onProgress){return transfer('/backup/export',{method:'POST',body:{}},onProgress);},
 importBackup(file,onProgress){return transfer('/backup/import',{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream'}},onProgress);},
};
