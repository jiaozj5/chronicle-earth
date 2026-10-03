import {readFile,stat} from 'node:fs/promises';
import {assert,DomainError} from '../../packages/contracts/index.js';
const fail=(code,message)=>new DomainError(code,message);
export function normalizeArkEndpoint(value){
 let url;try{url=new URL(value);}catch{throw fail('INVALID_INPUT','请输入完整的火山方舟 Base URL。');}
 assert(url.protocol==='https:'&&/^ark\.[a-z0-9-]+\.volces\.com$/.test(url.hostname)&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash,'请使用官方火山方舟 HTTPS 地址，密钥填写在 API Key 栏。');
 const p=url.pathname.replace(/\/+$/,'');assert(['/api/v3','/api/v3/chat/completions'].includes(p),'Base URL 路径应为 /api/v3。');url.pathname=p.endsWith('/chat/completions')?p:p+'/chat/completions';return url.toString();
}
async function imageData(file){const size=(await stat(file)).size;assert(size<=15*1024*1024,'当前页图片过大，请取消附图后重试。');const data=await readFile(file);const mime=data[0]===0x89?'image/png':data[0]===0xff?'image/jpeg':null;assert(mime,'此页图片格式暂不支持，请取消附图。');return'data:'+mime+';base64,'+data.toString('base64');}
export function createDoubaoProvider({fetchImpl=globalThis.fetch}={}){return{
 async generate({settings,model,instructions,prompt,imagePath,tools=[],callTool,signal,onText=()=>{},onStatus=()=>{},timeoutMs=180000}){
  const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false,body='';const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
   const content=imagePath?[{type:'text',text:prompt},{type:'image_url',image_url:{url:await imageData(imagePath)}}]:prompt;
   const messages=[{role:'system',content:instructions},{role:'user',content}];
   for(let round=0;round<12;round++){
    if(controller.signal.aborted)throw fail('CANCELLED','已停止生成');onStatus(round?'豆包正在继续处理…':'正在连接豆包…');
    const response=await fetchImpl(normalizeArkEndpoint(settings.endpoint),{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+settings.apiKey},body:JSON.stringify({model,messages,stream:true,...(tools.length?{tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}})),parallel_tool_calls:false}:{})})});
    if(!response.ok){await response.body?.cancel();throw fail(response.status===401||response.status===403?'PROVIDER_AUTH':response.status===429?'PROVIDER_LIMIT':'PROVIDER_UNAVAILABLE',response.status===401||response.status===403?'豆包鉴权失败，请检查 API Key 和模型权限。':response.status===429?'豆包额度或请求频率受限，请稍后重试。':'豆包请求失败（HTTP '+response.status+'），请检查模型 ID、图像和工具能力配置。');}
    assert(response.headers.get('content-type')?.includes('text/event-stream'),'豆包未返回流式响应，请检查服务地址。','MODEL_OUTPUT_INVALID');
    const reader=response.body.getReader(),decoder=new TextDecoder(),calls=new Map();let buffer='',text='',reasoning='',finish=null,ended=false,total=0;
    const event=data=>{if(data==='[DONE]'){ended=true;return;}let item;try{item=JSON.parse(data);}catch{throw fail('MODEL_OUTPUT_INVALID','豆包响应格式无效。');}if(item.error)throw fail('PROVIDER_UNAVAILABLE','豆包返回错误，请检查模型能力与服务状态。');const c=item.choices?.[0];if(!c)return;if(c.finish_reason)finish=c.finish_reason;const d=c.delta||{};
     if(d.reasoning_content){reasoning+=d.reasoning_content;onStatus('豆包正在思考…');}if(d.content){text+=d.content;assert(body.length+text.length<=100000,'回答过长，已停止。','MODEL_OUTPUT_INVALID');onText(body+text);}
     for(const t of d.tool_calls||[]){assert(Number.isInteger(t.index)&&t.index>=0&&t.index<16,'工具调用数量异常。','MODEL_OUTPUT_INVALID');const call=calls.get(t.index)||{id:'',type:'function',function:{name:'',arguments:''}};if(t.id)call.id=t.id;if(t.function?.name)call.function.name+=t.function.name;if(t.function?.arguments)call.function.arguments+=t.function.arguments;assert(call.function.arguments.length<=64000,'工具参数过长。','MODEL_OUTPUT_INVALID');calls.set(t.index,call);}
    };
    try{while(true){const chunk=await reader.read();total+=chunk.value?.length||0;assert(total<=2*1024*1024,'模型响应过大。','MODEL_OUTPUT_INVALID');buffer+=decoder.decode(chunk.value||new Uint8Array(),{stream:!chunk.done});buffer=buffer.replace(/\r\n/g,'\n');let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data)event(data);}if(chunk.done)break;}}
    finally{reader.releaseLock();}
    assert(ended&&finish,'豆包连接中断，已保留收到的内容，可重试。','PROVIDER_UNAVAILABLE');
    const pending=[...calls.values()];
    if(finish==='tool_calls'){
     assert(pending.length&&tools.length&&callTool,'当前模型没有启用工具调用。','MODEL_OUTPUT_INVALID');messages.push({role:'assistant',content:text||null,tool_calls:pending,...(reasoning?{reasoning_content:reasoning}:{})});if(text)body+=text+'\n\n';
     for(const call of pending){assert(call.id&&tools.some(t=>t.name===call.function.name),'模型请求了未开放的工具。','OPERATION_NOT_ALLOWED');let args;try{args=JSON.parse(call.function.arguments);}catch{args=null;}const result=await callTool(call.function.name,args,call.id);messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});}continue;
    }
    assert(finish==='stop'&&!pending.length,finish==='length'?'豆包回答达到长度上限，已保留内容，可继续追问。':'豆包未完成回答，请重试。','MODEL_OUTPUT_INVALID');body+=text;assert(body.trim(),'豆包返回了空回答。','MODEL_OUTPUT_INVALID');return{body,model,provider:'doubao'};
   }throw fail('TOOL_LIMIT','本次工具调用已达到上限，请继续追问。');
  }catch(e){if(signal?.aborted)throw fail('CANCELLED','已停止生成');if(timedOut)throw fail('PROVIDER_TIMEOUT','豆包回答超时，已保留内容，可重试。');if(e.code)throw e;throw fail('PROVIDER_UNAVAILABLE','无法连接豆包，请检查网络和服务配置。');}
  finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}
 }
};}
