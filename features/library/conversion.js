import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm,copyFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {marked} from '../../packages/ui/vendor/marked/lib/marked.esm.js';
import {id,DomainError,assert} from '../../packages/contracts/index.js';
import {PROFILE,normalizeBlock,canonicalText} from './model.js';

const here=path.dirname(fileURLToPath(import.meta.url));
export function pythonPath(){return process.env.CHRONICLE_PYTHON||[path.resolve('.local/python/Scripts/python.exe'),path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')].find(existsSync)||'python';}
export async function converterStatus(){return new Promise(resolve=>{const child=spawn(pythonPath(),[path.join(here,'convert.py'),'--check'],{windowsHide:true});let out='';const timer=setTimeout(()=>{child.kill();resolve({available:false,reason:'转换运行时检查超时'});},5000);child.stdout.on('data',b=>out+=b);child.on('error',()=>{clearTimeout(timer);resolve({available:false,reason:'未找到 Python；可设置 CHRONICLE_PYTHON'});});child.on('close',()=>{clearTimeout(timer);try{resolve({available:true,...JSON.parse(out)});}catch{resolve({available:false,reason:'转换运行时不可用'});}});});}
export async function readEmbeddedMetadata(attachment){
 const format=path.extname(attachment.name).toLowerCase();if(!['.pdf','.epub'].includes(format))return {};
 return new Promise(resolve=>{const child=spawn(pythonPath(),[path.join(here,'convert.py'),attachment.path,'--metadata','--format',format],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});let out='';
  const timer=setTimeout(()=>{child.kill();resolve({});},10000);child.stdout.on('data',b=>{out+=b;if(out.length>65536)child.kill();});child.stderr.resume();child.on('error',()=>{clearTimeout(timer);resolve({});});child.on('close',code=>{clearTimeout(timer);try{resolve(code===0?JSON.parse(out):{});}catch{resolve({});}});
 });
}
function inline(tokens){const runs=[];for(const t of tokens||[]){
 if(t.type==='image')runs.push({text:'[图片：'+(t.text||t.href)+']'});
 else if(t.tokens){for(const r of inline(t.tokens))runs.push({...r,...(t.type==='strong'?{bold:true}:{}),...(t.type==='em'?{italic:true}:{})});}
 else {const raw=canonicalText(t.type==='br'?'\n':t.text??t.raw??'');let at=0;const re=/\$([^$\n]+)\$|\\\((.+?)\\\)/g;for(const m of raw.matchAll(re)){if(m.index>at)runs.push({text:raw.slice(at,m.index)});runs.push({atom:'formula',latex:m[1]||m[2]});at=m.index+m[0].length;}if(at<raw.length)runs.push({text:raw.slice(at)});}
 }return runs;}
export function fromText(body,{markdown=false,title='' }={}){
 const blocks=[];
 function add(kind,runs,extra={}){const text=runs.map(r=>r.atom?'\uFFFC':r.text).join('');if(text.trim())blocks.push(normalizeBlock({kind,text,runs,...extra}));}
 if(!markdown){for(const p of canonicalText(body).split(/\n\s*\n/))add('paragraph',[{text:p}]);}
 else{
  const walk=tokens=>{for(const t of tokens){if(t.type==='space')continue;
   if(t.type==='heading')add('heading',inline(t.tokens),{level:t.depth});
   else if(t.type==='code')add('code',[{text:canonicalText(t.text)}]);
   else if(t.type==='table'){const tableId=id('table');[t.header,...t.rows].forEach((row,rowIndex)=>row.forEach((cell,col)=>add('table-cell',inline(cell.tokens),{tableId,row:rowIndex,col,header:rowIndex===0})));}
   else if(t.type==='list')t.items.forEach(item=>walk(item.tokens));
   else if(t.type==='blockquote')walk(t.tokens);
   else if(t.type==='html')add('paragraph',[{text:canonicalText(t.raw)}]);
   else {const value=(t.text||'').trim(),m=/^\$\$([\s\S]+)\$\$$/.exec(value);if(m)add('formula',[{atom:'formula',latex:m[1].trim()}],{latex:m[1].trim()});else add('paragraph',inline(t.tokens||[{text:t.text||t.raw||''}]));}
  }};walk(marked.lexer(canonicalText(body)));
 }
 // Chunk long material into lightweight reading pages without changing block text.
 const pages=[];let size=0;for(const b of blocks){if(!pages.length||size>6000){pages.push({index:pages.length,label:String(pages.length+1),width:720,height:1000,status:'ready',warnings:[]});size=0;}b.pageIndex=pages.length-1;size+=b.text.length;}
 if(!pages.length)pages.push({index:0,label:'1',width:720,height:1000,status:'ready',warnings:[]});
 return{profile:PROFILE,renditionId:id('rendition'),title,blocks,pages,engine:markdown?'markdown':'text',warnings:[]};
}
export async function convertAttachment(attachment,{mode='auto',onPage,signal,workspace}){
 const directory=await mkdtemp(path.join(tmpdir(),'chronicle-convert-'));
 const ext=path.extname(attachment.name).toLowerCase();assert(['.pdf','.epub','.png','.jpg','.jpeg','.webp','.tif','.tiff'].includes(ext),'此附件不能自动转换');
 const source=path.join(directory,'source'+ext);if(attachment.path)await copyFile(attachment.path,source);else await writeFile(source,attachment.buffer);
 const doc={profile:PROFILE,renditionId:id('rendition'),blocks:[],pages:[],engine:mode,warnings:[],attachmentIds:[]};const assets=new Map();
 let errors='',complete=false,processError=null;
 try{
  const child=spawn(pythonPath(),[path.join(here,'convert.py'),source,'--mode',mode,'--output',directory],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  const stopped=new Promise(resolve=>{child.on('error',e=>{processError=e;resolve(-1);});child.on('close',resolve);});
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-12000);});
  async function save(data,name,mime){const a=workspace.putAttachment(Buffer.from(data,'base64'),{name,mime});doc.attachmentIds.push(a.id);return a.id;}
  try{for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
   if(!line.trim())continue;let item;try{item=JSON.parse(line);}catch{continue;}
   if(item.event==='metadata'){doc.embeddedMetadata=item.metadata;continue;}
   if(item.event==='outline'){doc.outline=item.items;continue;}
   if(item.event==='error'){processError=new Error(item.message);continue;}
   if(item.event==='complete'){complete=true;continue;}
   if(item.event==='start'){doc.engine=item.engine;doc.totalPages=item.pages;await onPage?.({completed:0,total:doc.totalPages});continue;}
   if(item.event==='asset'){assets.set(item.key,{id:await save(item.data,item.name,item.mime),mime:item.mime});continue;}
   if(item.event==='page'){
    const page=item.page;if(item.image)page.imageAttachmentId=await save(item.image,'page-'+page.index+'.png','image/png');
    for(const b of item.blocks){if(b.image){b.imageAttachmentId=await save(b.image,b.id+'.png','image/png');delete b.image;}for(const r of b.runs||[]){if(r.assetKey){const asset=assets.get(r.assetKey);r.attachmentId=asset?.id||null;r.mime=asset?.mime||null;delete r.assetKey;}}doc.blocks.push(normalizeBlock(b));}
    doc.pages.push(page);await onPage?.({completed:doc.pages.length,total:doc.totalPages||null,page});
   }
  }}finally{signal?.removeEventListener('abort',abort);}
  const code=await stopped;
  if(signal?.aborted)throw new DomainError('CANCELLED','转换已取消；原件仍保留。');
  if(!complete||code!==0)throw new DomainError('CONVERTER_UNAVAILABLE',processError?.message||errors||'转换没有完成；请检查本机 Python 和转换组件。',{completedPages:doc.pages.length});
  return doc;
 }finally{const resolved=path.resolve(directory);if(resolved.startsWith(path.resolve(tmpdir())+path.sep))await rm(resolved,{recursive:true,force:true});}
}
