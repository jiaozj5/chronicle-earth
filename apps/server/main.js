import http from 'node:http';
import {readFile,writeFile,mkdir,rename,stat,rm} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {Workspace} from '../../packages/workspace/index.js';
import {DomainError,id,createChange} from '../../packages/contracts/index.js';
import {parseTime,overlaps,toRange} from '../../features/atlas/time.js';
import {projectAtlas} from '../../features/atlas/service.js';
import {validateCommit} from './validate.js';
import {projectionIndex,timeFilteredIds} from './projection-index.js';
import {createOperationsService} from './operations.js';
import {createLibraryService} from '../../features/library/service.js';
import {createUploads} from './uploads.js';
import {sendAttachment,verifiedAttachment} from './attachment-response.js';
import {AGENT_GUIDE,AGENT_INSTRUCTIONS} from '../../features/library/agent-guide.js';
import {libraryOpenApi} from '../../features/library/openapi.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.geojson':'application/geo+json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.ico':'image/x-icon','.wasm':'application/wasm'};
async function readJSON(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function atomicJSON(file,value){const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2),'utf8');await rename(temp,file);}
async function bodyJSON(req,max=16*1024*1024){let n=0;const parts=[];for await(const part of req){n+=part.length;if(n>max)throw new DomainError('CAPACITY_EXCEEDED','这次写入过大，请分批保存。');parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw new DomainError('INVALID_INPUT','提交格式无效。');}}
function param(query,key,fallback){const value=query.get(key);if(value===null)return fallback;try{return JSON.parse(value);}catch{return value;}}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function errorResponse(res,error){if(res.writableEnded||res.destroyed)return;const code=error.code||'STORAGE_FAILED';const status={INVALID_INPUT:400,VERSION_CONFLICT:409,IDEMPOTENCY_CONFLICT:409,STORAGE_BUSY:409,DISCUSSION_BUSY:409,NOT_FOUND:404,DELETED:410,CAPACITY_EXCEEDED:413,INVALID_BACKUP:422,UNSUPPORTED_VERSION:422,SERVICE_NOT_CONFIGURED:422,SERVICE_UNAVAILABLE:503,CANCELLED:499,REFERENCE_UNAVAILABLE:422,OPERATION_NOT_ALLOWED:403,INVALID_STATE:409,TIME_UNRESOLVED:422,PLACE_REQUIRED:422,INVALID_PLACE:422,TARGET_UNRESOLVED:422,TARGET_AMBIGUOUS:422,RENDITION_UNAVAILABLE:422,RESOURCE_MISSING:404,CONVERTER_UNAVAILABLE:503,UNSUPPORTED_OPERATION:422,READER_UNAVAILABLE:409}[code]||500;json(res,status,{error:{code,message:error.code?error.message:'操作未完成，原有内容已保留。',details:error.details||{}}});}
function projectRootPath(urlPath){const prefixes=['/apps/client/','/packages/ui/','/packages/contracts/','/features/'];if(!prefixes.some(p=>urlPath.startsWith(p)))return null;const decoded=decodeURIComponent(urlPath);const target=path.resolve(ROOT,'.'+decoded);if(!target.startsWith(ROOT+path.sep))return null;if(/(?:^|[\\/])(?:\.\.|\.local|\.git)(?:[\\/]|$)/.test(decoded))return null;return target;}

export async function createAppServer(options={}){
 const dataDir=path.resolve(options.dataDir||process.env.CHRONICLE_DATA_DIR||path.join(ROOT,'.local'));
 await mkdir(dataDir,{recursive:true});await mkdir(path.join(dataDir,'workspaces'),{recursive:true});await mkdir(path.join(dataDir,'transfers'),{recursive:true});
 const activeFile=path.join(dataDir,'active.json');const active=await readJSON(activeFile,{name:'main'});
 if(!/^[A-Za-z0-9_-]+$/.test(active.name))throw new Error('Invalid workspace name');
 let workspace=new Workspace(path.join(dataDir,'workspaces',active.name));
 let settings=await readJSON(path.join(dataDir,'settings.json'),{endpoint:'',model:'',apiKey:''});
 const operations=createOperationsService({getWorkspace:()=>workspace,validateCommit});
 const library=createLibraryService({getWorkspace:()=>workspace});
 const uploads=await createUploads(path.join(dataDir,'transfers','attachment-uploads'),()=>workspace);
 const token=randomBytes(24).toString('hex');const downloads=new Map(),transfers=new Map();let seedsDone=false,restoring=false,exportsRunning=0,personaRequests=0,activeMutations=0;
 function transferFor(url,kind){const key=url.searchParams.get('transferId')||randomUUID();if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key))throw new DomainError('INVALID_INPUT','传输标识无效。');if(transfers.has(key))throw new DomainError('IDEMPOTENCY_CONFLICT','这个传输已启动，请等候完成。');const progress={id:key,kind,phase:'preparing',completedBytes:0,totalBytes:null};transfers.set(key,progress);if(transfers.size>100){for(const [k,v]of transfers){if(['complete','failed'].includes(v.phase)){transfers.delete(k);break;}}}return{update:value=>Object.assign(progress,value),fail:error=>Object.assign(progress,{phase:'failed',error:error.message})};}
 if(options.seed!==false){try{const places=JSON.parse(await readFile(path.join(ROOT,'features/atlas/data/places.json'),'utf8'));const exists=await workspace.list({objectType:'place',limit:1});if(exists.total===0){await workspace.commit({requestId:'initial-geography-v1',changes:places.map(p=>({id:p.id,objectType:'place',expectedRevision:0,data:p.data}))});}seedsDone=true;}catch(e){if(e.code!=='ENOENT')throw e;}}
 async function all(type){return(await workspace.list({objectType:type,limit:100000})).items;}
 async function getObject(objectId,revision){return workspace.get(objectId,{revision,includeDeleted:true});}
 async function handleAdoption(body){
  const requestId=body.requestId||id('adopt');const receiptId='adoption_'+requestId;const inputHash=createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
  let priorReceipt;try{priorReceipt=await workspace.get(receiptId,{revision:1,includeDeleted:true});}catch(e){if(e.code!=='NOT_FOUND')throw e;}
  if(priorReceipt){if(priorReceipt.data.inputHash!==inputHash)throw new DomainError('IDEMPOTENCY_CONFLICT','同一采纳请求不能用于不同内容。');const ref=priorReceipt.data.targetRefs[0];const saved=await workspace.get(ref.targetId,{revision:ref.revision,includeDeleted:true});const before=priorReceipt.data.changes[0].before;const result=await workspace.commit({requestId,changes:[{id:saved.id,objectType:saved.objectType,expectedRevision:before?.revision||0,data:saved.data},createChange('adoption',priorReceipt.data,receiptId)]});return{...result,targetId:saved.id,adoptionId:receiptId};}
  const message=await getObject(body.messageId,body.messageRevision);if(message.objectType!=='message'||message.data.role!=='assistant'||message.data.status!=='complete'||message.data.pending)throw new DomainError('INVALID_INPUT','请选择一条已完成的人物回复。');
  const objectType=body.targetType||'knowledge';if(!['entry','knowledge','document'].includes(objectType))throw new DomainError('INVALID_INPUT','采纳目标类型无效。');
  const previous=body.targetId?await workspace.get(body.targetId):null;if(previous&&previous.objectType!==objectType)throw new DomainError('INVALID_INPUT','目标类型不匹配。');
  if(previous&&(!Number.isInteger(body.targetRevision)||body.targetRevision!==previous.revision))throw new DomainError('VERSION_CONFLICT','目标内容已有变化，请重新选择并核对后再采纳。',{id:previous.id,currentRevision:previous.revision,expectedRevision:body.targetRevision});
  const targetId=previous?.id||body.newTargetId||('adopted_'+requestId);const bodyText=String(body.body??message.data.body??'').trim();if(!bodyText)throw new DomainError('INVALID_INPUT','先写下要采纳的内容。');
  const messageRef={targetId:message.id,versionMode:'pinned',revision:message.revision,locator:{discussionId:message.data.discussionId},quote:bodyText===message.data.body?bodyText:null};
  const data={...(previous?.data||{}),title:body.title||previous?.data.title||bodyText.split('\n')[0].slice(0,60),body:bodyText,citations:[...(previous?.data.citations||[]),...(message.data.citations||[])]};
  if(objectType==='knowledge')data.kind=body.kind||previous?.data.kind||'question';
  if(objectType==='entry'){data.kind=body.kind||previous?.data.kind||'note';data.status='adopted';data.occurrenceTime=body.occurrenceTime||previous?.data.occurrenceTime||null;data.placeRefs=body.placeRefs||previous?.data.placeRefs||[];}
  const revision=(previous?.revision||0)+1;
  // Business modules validate their own target before the single storage transaction.
  const module=await import(objectType==='entry'?'../../features/chronicle/service.js':'../../features/knowledge/service.js');
  const targetChange=module.prepareAdoptionChange({target:previous,objectType,data,messageRef,newId:targetId});
  const changes=[targetChange,createChange('adoption',{messageRef,targetRefs:[{targetId,versionMode:'pinned',revision}],changes:[{id:targetId,before:previous,afterRevision:revision}],status:'active',inputHash},receiptId)];
  const result=await workspace.commit({requestId,changes});return{...result,targetId,adoptionId:receiptId};
 }
 const server=http.createServer(async(req,res)=>{
  const host=req.headers.host||'';
  if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)){json(res,403,{error:{code:'INVALID_INPUT',message:'此应用只接受本机访问。'}});return;}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const url=new URL(req.url,'http://'+host);const route=url.pathname;
  try{
   if(route.startsWith('/api/')){
    if(req.headers.origin&&req.headers.origin!=='http://'+host)throw new DomainError('INVALID_INPUT','来源不一致，已拒绝请求。');
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-chronicle-token']!==token){json(res,403,{error:{code:'INVALID_INPUT',message:'会话已更新，请刷新后重试。'}});return;}
    if(restoring&&!['GET','HEAD'].includes(req.method))throw new DomainError('STORAGE_BUSY','正在恢复工作空间，阅读仍可继续。请在恢复完成后保存。');
    if(!['GET','HEAD'].includes(req.method)){
     activeMutations++;let released=false;const release=()=>{if(!released){released=true;activeMutations--;}};res.once('finish',release);res.once('close',release);
    }
    if(route==='/api/session'){json(res,200,{token,product:'chronicle-earth',version:'0.2.0',workspaceId:(await workspace.stats()).workspaceId,seedsDone});return;}
    if(route==='/api/operations/schema'&&req.method==='GET'){json(res,200,operations.discovery());return;}
    if(route==='/api/operations'&&req.method==='POST'){json(res,200,await operations.execute(await bodyJSON(req)));return;}
    if(route==='/api/operations/connection'&&req.method==='GET'){json(res,200,{mcpServers:{chronicle:{command:process.execPath,args:[path.join(ROOT,'scripts/agent-mcp.mjs')],env:{CHRONICLE_URL:'http://'+host}}}});return;}
    if(route==='/api/library/schema'&&req.method==='GET'){const tools=library.tools.filter(t=>t.name!=='reader_sync');json(res,200,{version:'1',instructions:AGENT_INSTRUCTIONS,guide:'/api/library/agent-guide',operations:tools,tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}))});return;}
    if(route==='/api/library/agent-guide'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(AGENT_GUIDE);return;}
    if(route==='/api/library/openapi.json'&&req.method==='GET'){json(res,200,libraryOpenApi('http://'+host));return;}
    if(route.startsWith('/api/library/tools/')&&req.method==='POST'){const name=route.slice('/api/library/tools/'.length);if(name==='reader_sync')throw new DomainError('OPERATION_NOT_ALLOWED','reader_sync 仅供阅读器心跳使用。');json(res,200,await library.call(name,await bodyJSON(req)));return;}
    if(route==='/api/library/connection'&&req.method==='GET'){json(res,200,{mcpServers:{'chronicle-library':{command:process.execPath,args:[path.join(ROOT,'scripts/library-mcp.mjs')],env:{CHRONICLE_URL:'http://'+host}}}});return;}
    if(route==='/api/library'&&req.method==='POST'){const b=await bodyJSON(req);json(res,200,await library.call(b.operation,{...b.arguments,...(b.requestId?{requestId:b.requestId}:{})}));return;}
    if(route.startsWith('/api/library/chat/')){json(res,410,{error:{code:'FEATURE_REMOVED',message:'应用内对话已关闭，请在外部 Agent 中连接 chronicle-library。'}});return;}
    if(route==='/api/stats'){json(res,200,await workspace.stats());return;}
    if(route==='/api/changes'&&req.method==='GET'){const after=Number(url.searchParams.get('after')||0);json(res,200,{...workspace.changesSince(after,{limit:1000}),workspaceId:workspace.stats().workspaceId});return;}
    if(route==='/api/objects'&&req.method==='GET'){
     const q={};for(const[key]of url.searchParams)q[key]=param(url.searchParams,key);
     const predicates=[];
     if(q.timeSpec){const spec=typeof q.timeSpec==='string'?parseTime(q.timeSpec):q.timeSpec;if(q.objectType==='entry'||q.objectTypes?.length===1&&q.objectTypes[0]==='entry')q.ids=timeFilteredIds(projectionIndex(workspace),spec,q);else predicates.push(o=>o.objectType!=='entry'||!!o.data.occurrenceTime&&overlaps(o.data.occurrenceTime,spec));delete q.timeSpec;}
     if(q.draftKind){const kind=q.draftKind;predicates.push(o=>o.objectType!=='draft'||(kind==='chronicle'?(!o.data.draftKind||o.data.draftKind==='chronicle'):o.data.draftKind===kind));delete q.draftKind;}
     if(q.parseStatus){const status=q.parseStatus;predicates.push(o=>o.data.parseStatus===status);delete q.parseStatus;}
     if(predicates.length)q.predicate=o=>predicates.every(p=>p(o));
     json(res,200,await workspace.list(q));return;
    }
    const objectMatch=route.match(/^\/api\/objects\/([^/]+)(\/history)?$/);
    if(objectMatch){const oid=decodeURIComponent(objectMatch[1]);json(res,200,objectMatch[2]?await workspace.history(oid):await workspace.get(oid,{revision:param(url.searchParams,'revision'),includeDeleted:param(url.searchParams,'includeDeleted',false)}));return;}
    if(route==='/api/commit'&&req.method==='POST'){const body=await bodyJSON(req);const replay=workspace.replayCommit(body);if(replay){json(res,200,replay);return;}await validateCommit(workspace,body);json(res,200,await workspace.commit(body));return;}
    if(route==='/api/atlas'){
     const time=param(url.searchParams,'time',null);const spec=typeof time==='string'?parseTime(time):time;
     const index=projectionIndex(workspace),q=url.searchParams.get('q')||undefined;
     const matchedEntryIds=q?new Set((await workspace.list({objectType:'entry',q,summary:true,limit:1000000})).items.map(o=>o.id)):undefined;
     const projection=projectAtlas([...index.entries.values()],[...index.places.values()],spec,{q,matchedEntryIds,kind:url.searchParams.get('kind')||undefined,placeIds:param(url.searchParams,'placeIds')});
     json(res,200,{...projection,sequence:index.sequence});return;
    }
    if(route==='/api/source-search'&&req.method==='POST'){const b=await bodyJSON(req);json(res,200,await workspace.searchSourceVersions(b.sourceRefs||[],b.query||'',{limit:b.limit||8}));return;}
    if(route==='/api/uploads'&&req.method==='POST'){json(res,200,await uploads.start(await bodyJSON(req)));return;}
    const uploadMatch=route.match(/^\/api\/uploads\/([a-f0-9-]{36})(\/complete)?$/);
    if(uploadMatch){
     if(req.method==='PUT'&&!uploadMatch[2]){json(res,200,await uploads.chunk(uploadMatch[1],Number(url.searchParams.get('offset')),req));return;}
     if(req.method==='POST'&&uploadMatch[2]){json(res,200,await uploads.finish(uploadMatch[1]));return;}
     if(req.method==='DELETE'&&!uploadMatch[2]){json(res,200,await uploads.cancel(uploadMatch[1]));return;}
     throw new DomainError('INVALID_INPUT','上传操作无效。');
    }
    if(route==='/api/attachments'&&req.method==='POST'){
     let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>64*1024*1024)throw new DomainError('CAPACITY_EXCEEDED','单个附件最多 64 MiB。');chunks.push(chunk);}json(res,200,await workspace.putAttachment(Buffer.concat(chunks),{name:url.searchParams.get('name')||'附件',mime:url.searchParams.get('mime')||'application/octet-stream'}));return;
    }
    if(route.startsWith('/api/attachments/')){const a=await verifiedAttachment(workspace,decodeURIComponent(route.slice(17)));await sendAttachment(req,res,a);return;}
    if(route==='/api/settings'){
     if(req.method==='POST'){const b=await bodyJSON(req);const endpoint=String(b.endpoint??settings.endpoint).trim();if(endpoint){let u;try{u=new URL(endpoint);}catch{throw new DomainError('INVALID_INPUT','请输入完整的模型服务地址。');}if(!['http:','https:'].includes(u.protocol))throw new DomainError('INVALID_INPUT','模型服务需使用 http 或 https 地址。');if(u.username||u.password)throw new DomainError('INVALID_INPUT','请将凭据填写在密钥栏，不要放入接口地址。');}const next={endpoint,model:String(b.model??settings.model).trim(),apiKey:b.apiKey===undefined?settings.apiKey:String(b.apiKey)};await atomicJSON(path.join(dataDir,'settings.json'),next);settings=next;}
     json(res,200,{endpoint:settings.endpoint,model:settings.model,hasApiKey:!!settings.apiKey,configured:!!settings.endpoint&&!!settings.model});return;
    }
    if(route.startsWith('/api/personas/')&&req.method==='POST'){
     personaRequests++;try{const mod=await import('../../features/personas/service.js');const b=await bodyJSON(req);const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});const result=await mod.handleRequest(route.slice('/api/personas/'.length),b,{workspace,settings,signal:controller.signal});json(res,200,result);}finally{personaRequests--;}return;
    }
    if(route==='/api/adopt'&&req.method==='POST'){json(res,200,await handleAdoption(await bodyJSON(req)));return;}
    const undo=route.match(/^\/api\/adopt\/([^/]+)\/undo$/);
    if(undo&&req.method==='POST'){
     const b=await bodyJSON(req),requestId=b.requestId||id('undo');const receipt=await workspace.get(decodeURIComponent(undo[1]));if(receipt.objectType!=='adoption')throw new DomainError('INVALID_INPUT','这不是一项采纳记录。');const changes=[];
     if(receipt.data.status==='undone'){
      if(receipt.data.undoRequestId===requestId){for(const c of receipt.data.changes){const saved=await workspace.get(c.id,{revision:c.afterRevision+1,includeDeleted:true});changes.push({id:saved.id,objectType:saved.objectType,expectedRevision:c.afterRevision,data:saved.data,deleted:!!saved.deletedAt});}changes.push({id:receipt.id,objectType:'adoption',expectedRevision:receipt.revision-1,data:receipt.data});json(res,200,await workspace.commit({requestId,changes}));}
      else json(res,200,{objects:[],alreadyUndone:true,adoptionId:receipt.id});return;
     }
     if(receipt.data.status!=='active')throw new DomainError('INVALID_INPUT','采纳状态无法撤销。');
     for(const c of receipt.data.changes){const current=await workspace.get(c.id,{includeDeleted:true});const mod=await import(current.objectType==='entry'?'../../features/chronicle/service.js':'../../features/knowledge/service.js');changes.push(mod.prepareUndoChange(current,c.before,c.afterRevision));}
     changes.push({id:receipt.id,objectType:'adoption',expectedRevision:receipt.revision,data:{...receipt.data,status:'undone',undoRequestId:requestId}});json(res,200,await workspace.commit({requestId,changes}));return;
    }
    if(route.startsWith('/api/backup/progress/')){const progress=transfers.get(route.slice('/api/backup/progress/'.length));json(res,200,progress||{phase:'preparing',completedBytes:0,totalBytes:null});return;}
    if(route==='/api/backup/export'&&req.method==='POST'){
     const transfer=transferFor(url,'export');exportsRunning++;try{const name='chronicle-'+Date.now()+'-'+randomBytes(3).toString('hex')+'.chronicle';const dest=path.join(dataDir,'transfers',name);await workspace.exportBackup(dest,{onProgress:transfer.update});const ticket=randomBytes(16).toString('hex');downloads.set(ticket,{file:dest,name});json(res,200,{url:'/api/download/'+ticket,name,size:(await stat(dest)).size});}catch(error){transfer.fail(error);throw error;}finally{exportsRunning--;}return;
    }
    if(route.startsWith('/api/download/')){const item=downloads.get(route.slice(14));if(!item)throw new DomainError('NOT_FOUND','下载已失效，请重新导出。');res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(item.name)});await pipeline(createReadStream(item.file),res);return;}
    if(route==='/api/backup/import'&&req.method==='POST'){
     if(exportsRunning||personaRequests||activeMutations>1||library.active||uploads.active)throw new DomainError('STORAGE_BUSY','请等当前上传、保存、备份、转换或讨论完成，再恢复工作空间。');
     const transfer=transferFor(url,'import');restoring=true;const dest=path.join(dataDir,'transfers','restore-'+randomUUID()+'.chronicle');let restored;
     try{let received=0;req.on('data',chunk=>{received+=chunk.length;transfer.update({phase:'upload',completedBytes:received,totalBytes:Number(req.headers['content-length'])||null});});await pipeline(req,createWriteStream(dest));const nextName='restored-'+Date.now()+'-'+randomBytes(3).toString('hex');restored=new Workspace(path.join(dataDir,'workspaces',nextName));await restored.importBackup(dest,{onProgress:transfer.update});await atomicJSON(activeFile,{name:nextName});const previous=workspace;workspace=restored;restored=null;await previous.close();json(res,200,{workspaceId:(await workspace.stats()).workspaceId,message:'已恢复到新的工作空间，原工作空间仍保留。'});}catch(e){transfer.fail(e);if(restored)await restored.close();throw e;}finally{restoring=false;await rm(dest,{force:true});}return;
    }
    throw new DomainError('NOT_FOUND','接口不存在。');
   }
   const file=route==='/'?path.join(ROOT,'apps/client/index.html'):projectRootPath(route);if(!file)throw new DomainError('NOT_FOUND','页面不存在。');
   const fileInfo=await stat(file);if(!fileInfo.isFile())throw new DomainError('NOT_FOUND','资源不存在。');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});if(req.method==='HEAD')res.end();else await pipeline(createReadStream(file),res);
  }catch(error){if(error.code==='ENOENT')error=new DomainError('NOT_FOUND','资源暂不可用。');errorResponse(res,error);}
 });
 return{server,library,get workspace(){return workspace;},dataDir,async close(){await library.close();await new Promise(resolve=>server.close(resolve));await uploads.close();await workspace.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const app=await createAppServer();const port=Number(process.env.PORT||4317);app.server.listen(port,'127.0.0.1',()=>console.log('岁月史书已启动：http://127.0.0.1:'+port));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});}
