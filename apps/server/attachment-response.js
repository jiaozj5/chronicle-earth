import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {stat} from 'node:fs/promises';

const verifiedFiles=new WeakMap();
const stamp=s=>[s.size,s.mtimeMs,s.ctimeMs,s.ino].join(':');
export async function verifiedAttachment(workspace,id){
 let cache=verifiedFiles.get(workspace);if(!cache){cache=new Map();verifiedFiles.set(workspace,cache);}
 const previous=cache.get(id);
 if(previous){const saved=await previous;try{if(stamp(await stat(saved.asset.path))===saved.stamp)return saved.asset;}catch{}cache.delete(id);}
 const pending=(async()=>{const asset=await workspace.getAttachmentFile(id);return{asset,stamp:stamp(await stat(asset.path))};})();cache.set(id,pending);
 try{const result=await pending;if(cache.size>200)cache.delete(cache.keys().next().value);return result.asset;}catch(e){cache.delete(id);throw e;}
}

// Verify once per unchanged file, then stream PDF.js disjoint chunks without buffering.
export async function sendAttachment(req,res,asset){
 const inline=/^image\/(png|jpeg|gif|webp)$/.test(asset.mime);
 const headers={'Content-Type':inline?asset.mime:'application/octet-stream','Content-Disposition':(inline?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(asset.name),'Cache-Control':'private, max-age=3600','Accept-Ranges':'bytes'};
 let start=0,end=asset.size-1,status=200;
 if(req.headers.range&&req.method!=='HEAD'){
  const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if(match&&(match[1]||match[2])){
   start=match[1]?Number(match[1]):Math.max(0,asset.size-Number(match[2]));
   end=match[1]&&match[2]?Math.min(Number(match[2]),end):end;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=asset.size){res.writeHead(416,{...headers,'Content-Range':'bytes */'+asset.size,'Content-Length':0});res.end();return;}
   status=206;headers['Content-Range']=`bytes ${start}-${end}/${asset.size}`;
  }
 }
 headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);
 if(req.method==='HEAD'||!asset.size)res.end();else try{await pipeline(createReadStream(asset.path,{start,end}),res);}catch(e){if(!res.destroyed)throw e;}
}
