import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {DomainError,assert} from '../../packages/contracts/index.js';

const fail=(code,message)=>new DomainError(code,message);
const restrictions={'features.shell_tool':false,'features.apps':false,'features.plugins':false,'features.multi_agent':false,'features.hooks':false,'features.memories':false,'features.browser_use':false,'features.code_mode.enabled':false,web_search:'disabled'};
export async function codexExecutable(){
 if(process.env.CHRONICLE_CODEX_PATH&&existsSync(process.env.CHRONICLE_CODEX_PATH))return process.env.CHRONICLE_CODEX_PATH;
 const name=process.platform==='win32'?'codex.exe':'codex';for(const dir of (process.env.PATH||'').split(path.delimiter))if(existsSync(path.join(dir,name)))return path.join(dir,name);
 if(process.platform==='win32'&&process.env.LOCALAPPDATA){const base=path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');try{const files=await Promise.all((await readdir(base)).map(async d=>{const file=path.join(base,d,name);try{return{file,time:(await stat(file)).mtimeMs};}catch{return null;}}));const latest=files.filter(Boolean).sort((a,b)=>b.time-a.time)[0];if(latest)return latest.file;}catch{}}
 throw fail('CODEX_UNAVAILABLE','未找到本机 Codex。请启动 Codex 并登录，再点击重新连接。');
}

// Only the official process handles authentication; credentials never enter this app.
export class CodexRpc{
 constructor(executable,cwd,{spawnImpl=spawn}={}){
  this.pending=new Map();this.listeners=new Set();this.sequence=0;
  const args=['app-server','--listen','stdio://',...Object.entries(restrictions).flatMap(([k,v])=>['-c',k+'='+JSON.stringify(v)])];
  this.child=spawnImpl(executable,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});this.child.stderr.resume();
  this.lines=createInterface({input:this.child.stdout});this.lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}
   if(value.id!==undefined&&!value.method){const task=this.pending.get(value.id);if(!task)return;this.pending.delete(value.id);clearTimeout(task.timer);if(value.error)task.reject(fail('CODEX_ERROR',String(value.error.message||'Codex 连接失败').slice(0,400)));else task.resolve(value.result);}
   else if(value.id!==undefined&&value.method){if(value.method==='item/tool/call'&&this.toolHandler)Promise.resolve().then(()=>this.toolHandler(value.params)).then(result=>this.write({id:value.id,result}),()=>this.write({id:value.id,result:{success:false,contentItems:[{type:'inputText',text:'Tool call failed.'}]}}));else this.write({id:value.id,error:{code:-32601,message:'This request is not available in the reading companion.'}});}
   else for(const listener of this.listeners)listener(value);
  });
  this.child.on('error',()=>this.failed(fail('CODEX_UNAVAILABLE','无法启动本机 Codex，请确认 Codex 能正常打开。')));
  this.child.on('exit',()=>this.failed(fail('CODEX_DISCONNECTED','Codex 连接已断开，问题已保留，可重试。')));
  this.child.stdin.on('error',()=>{});
 }
 write(value){if(!this.closed&&!this.child.stdin.destroyed)this.child.stdin.write(JSON.stringify(value)+'\n');}
 request(method,params={},timeoutMs=20000){return new Promise((resolve,reject)=>{if(this.closed){reject(fail('CODEX_DISCONNECTED','Codex 连接已关闭。'));return;}const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(fail('CODEX_TIMEOUT','Codex 连接超时，请重新连接。'));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.write({id,method,params});});}
 failed(error){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();for(const listener of this.listeners)listener({method:'connection/error',params:{error}});}
 close(){this.failed(fail('CANCELLED','已停止生成'));this.lines.close();this.child.stdin.end();this.child.kill();}
 async initialize(){await this.request('initialize',{clientInfo:{name:'chronicle_reading_companion',title:'岁月史书伴读',version:'0.3.0'},capabilities:{experimentalApi:true}});this.write({method:'initialized',params:{}});}
}

export function createCodexProvider({directory,createRpc=(exe,cwd)=>new CodexRpc(exe,cwd),findExecutable=codexExecutable}={}){
 let cached=null,modelCache=null;
 async function open(signal){await mkdir(directory,{recursive:true});if(signal?.aborted)throw fail('CANCELLED','已停止生成');const rpc=createRpc(await findExecutable(),directory),abort=()=>rpc.close();signal?.addEventListener('abort',abort,{once:true});try{if(signal?.aborted)throw fail('CANCELLED','已停止生成');await rpc.initialize();return rpc;}catch(e){rpc.close();throw e;}finally{signal?.removeEventListener('abort',abort);}}
 async function account(rpc){const r=await rpc.request('account/read',{refreshToken:false});return{connected:r.account?.type==='chatgpt',provider:'codex',authType:r.account?.type||null};}
 return{
  async models({refresh=false}={}){if(!refresh&&modelCache&&Date.now()-modelCache.at<300000)return structuredClone(modelCache.value);let rpc;try{rpc=await open();const models=[];let cursor;do{const result=await rpc.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});for(const m of result.data||[])if(!m.hidden)models.push({id:m.model||m.id,label:m.displayName||m.model||m.id,reasoningEfforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort),defaultReasoningEffort:m.defaultReasoningEffort,vision:!m.inputModalities||m.inputModalities.includes('image'),isDefault:m.isDefault});cursor=result.nextCursor;}while(cursor&&models.length<500);modelCache={at:Date.now(),value:models};return structuredClone(models);}finally{rpc?.close();}},
  async status({refresh=false}={}){if(!refresh&&cached&&Date.now()-cached.at<30000)return cached.value;let rpc;try{rpc=await open();const value=await account(rpc);value.message=value.connected?'已连接 Codex · 使用当前 ChatGPT 登录':'请先在 Codex 中登录 ChatGPT，再点击重新连接。';cached={at:Date.now(),value};return value;}catch(e){return{connected:false,provider:'codex',message:e.message};}finally{rpc?.close();}},
  async generate({instructions,prompt,imagePath,model='',effort='',tools=[],callTool,signal,onText=()=>{},onStatus=()=>{},timeoutMs=180000}){
   let rpc,threadId,turnId,timer,abort,handler,closeOnAbort;const parts=new Map();let body='';
   const publish=()=>{let values=[...parts.values()];if(values.some(v=>v.phase==='final_answer'))values=values.filter(v=>v.phase==='final_answer');const next=values.map(v=>v.text).join('\n\n');assert(next.length<=100000,'回答过长，已停止。','MODEL_OUTPUT_INVALID');if(next!==body){body=next;onText(body);}};
   try{
    if(signal?.aborted)throw fail('CANCELLED','已停止生成');onStatus('正在连接 Codex…');rpc=await open(signal);closeOnAbort=()=>rpc.close();signal?.addEventListener('abort',closeOnAbort,{once:true});if(signal?.aborted)throw fail('CANCELLED','已停止生成');assert((await account(rpc)).connected,'请先在 Codex 中登录 ChatGPT，再点击重新连接。','CODEX_LOGIN_REQUIRED');
    const config=(await rpc.request('config/read',{includeLayers:false,cwd:directory})).config||{};
    const safeConfig={...restrictions,mcp_servers:Object.fromEntries(Object.keys(config.mcp_servers||{}).map(k=>[k,{enabled:false}]))};
    rpc.toolHandler=async p=>{assert(p.threadId===threadId&&!signal?.aborted&&tools.some(t=>t.name===p.tool)&&callTool,'工具调用不在当前会话范围。','OPERATION_NOT_ALLOWED');const result=await callTool(p.tool,p.arguments,p.callId);return{success:result.success!==false,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};};
    const started=await rpc.request('thread/start',{cwd:directory,ephemeral:true,environments:[],approvalPolicy:'never',sandbox:'read-only',baseInstructions:instructions,config:safeConfig,...(model?{model}:{}),...(tools.length?{dynamicTools:tools.map(t=>({type:'function',name:t.name,description:t.description,inputSchema:t.inputSchema}))}:{})});threadId=started.thread.id;
    const finished=new Promise((resolve,reject)=>{
     handler=event=>{const p=event.params||{};if(event.method==='connection/error'){reject(p.error);return;}if(p.threadId!==threadId)return;try{
      if(event.method==='error'&&p.willRetry)onStatus('连接短暂中断，Codex 正在重连…');
      if(event.method==='item/started'&&p.item?.type==='agentMessage'){for(const[k,v]of parts)if(!v.complete)parts.delete(k);parts.set(p.item.id,{text:p.item.text||'',phase:p.item.phase,complete:false});publish();}
      if(event.method==='item/agentMessage/delta'){const item=parts.get(p.itemId)||{text:'',complete:false};item.text+=p.delta;parts.set(p.itemId,item);publish();}
      if(event.method==='item/completed'&&p.item?.type==='agentMessage'){parts.set(p.item.id,{text:p.item.text||'',phase:p.item.phase,complete:true});publish();}
      if(event.method==='turn/completed'){if(p.turn.status==='completed'){
       // The completed turn replaces abandoned fragments from network retries.
       const final=p.turn.items?.filter(i=>i.type==='agentMessage');if(final?.length){parts.clear();for(const item of final)parts.set(item.id,{text:item.text,phase:item.phase,complete:true});}else for(const[k,v]of parts)if(!v.complete)parts.delete(k);
       publish();resolve();
      }else reject(fail(p.turn.status==='interrupted'?'CANCELLED':'CODEX_ERROR',p.turn.status==='interrupted'?'已停止生成':String(p.turn.error?.message||'Codex 未完成回答，请重试。').slice(0,400)));}
     }catch(e){reject(e);}
     };rpc.listeners.add(handler);
     timer=setTimeout(()=>reject(fail('CODEX_TIMEOUT','Codex 回答超时，已保留收到的内容，可重试。')),timeoutMs);
     abort=()=>{if(turnId)rpc.request('turn/interrupt',{threadId,turnId},3000).catch(()=>{});reject(fail('CANCELLED','已停止生成'));};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });finished.catch(()=>{});
    const input=[{type:'text',text:prompt}];if(imagePath)input.push({type:'localImage',path:imagePath});
    if(signal?.aborted)throw fail('CANCELLED','已停止生成');onStatus('Codex 正在思考…');const turn=await rpc.request('turn/start',{threadId,input,environments:[],...(effort?{effort}:{})});turnId=turn.turn.id;await finished;
    assert(body.trim(),'Codex 返回了空回答，请重试。','MODEL_OUTPUT_INVALID');return{body,model:started.model||null,provider:'codex'};
   }catch(e){if(signal?.aborted)throw fail('CANCELLED','已停止生成');throw e;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);signal?.removeEventListener('abort',closeOnAbort);if(handler)rpc?.listeners.delete(handler);rpc?.close();}
  }
 };
}
