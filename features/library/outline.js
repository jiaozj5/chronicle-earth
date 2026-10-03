import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pythonPath} from './conversion.js';

export function cleanOutline(items,pageCount){
 return (Array.isArray(items)?items:[]).slice(0,5000).filter(h=>h&&typeof h.title==='string'&&h.title.trim()&&Number.isInteger(h.pageIndex)&&h.pageIndex>=0&&h.pageIndex<pageCount).map((h,i)=>({id:typeof h.id==='string'?h.id:'outline-'+i,title:h.title.trim().slice(0,500),pageIndex:h.pageIndex,level:Math.max(1,Math.min(12,Math.trunc(h.level)||1)),source:h.source||'document'}));
}
export function readPdfOutline(file,pageCount){
 return new Promise((resolve,reject)=>{
  const child=spawn(pythonPath(),[fileURLToPath(new URL('./outline.py',import.meta.url)),file],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});let output='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('原书目录读取超时'));},10000);
  child.stdout.on('data',b=>{output+=b;if(output.length>4*1024*1024){child.kill();reject(new Error('原书目录过大'));}});child.stderr.resume();
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error('原书目录暂时不可用');resolve(cleanOutline(JSON.parse(output),pageCount));}catch(e){reject(e);}});
 });
}
