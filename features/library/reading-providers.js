import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assert} from '../../packages/contracts/index.js';
import {createDoubaoProvider,normalizeArkEndpoint} from './doubao-provider.js';

export async function createReadingProviders({directory,codex,fetchImpl}){
 const file=path.join(directory,'reading-models.json');let saved={endpoint:'https://ark.cn-beijing.volces.com/api/v3',apiKey:'',models:[]};
 try{saved={...saved,...JSON.parse(await readFile(file,'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}
 const doubao=createDoubaoProvider({fetchImpl});
 const publicSettings=()=>({endpoint:saved.endpoint,hasApiKey:!!saved.apiKey,models:structuredClone(saved.models)});
 return{
  settings:()=>publicSettings(),
  async configure(value){
   assert(value&&Object.keys(value).every(k=>['endpoint','apiKey','models'].includes(k)),'模型配置字段无效。');
   const endpoint=normalizeArkEndpoint(value.endpoint||saved.endpoint).replace(/\/chat\/completions$/,'');
   assert(Array.isArray(value.models)&&value.models.length<=20,'最多配置 20 个豆包模型。');
   const models=value.models.map(m=>{assert(m&&Object.keys(m).every(k=>['id','label','vision','tools'].includes(k))&&typeof m.id==='string'&&/^[a-zA-Z0-9._:/-]{1,200}$/.test(m.id),'请填写有效的 Model ID 或 Endpoint ID。');assert(typeof m.label==='string'&&m.label.trim().length<=100&&typeof m.vision==='boolean'&&typeof m.tools==='boolean','模型名称或能力选项无效。');return{...m,label:m.label.trim()||m.id};});
   assert(new Set(models.map(m=>m.id)).size===models.length,'模型 ID 不能重复。');
   assert(value.apiKey===undefined||typeof value.apiKey==='string'&&value.apiKey.length<=4096&&!/[\r\n]/.test(value.apiKey),'API Key 格式无效。');
   assert(endpoint===saved.endpoint||!saved.apiKey||value.apiKey!==undefined,'更换服务地址时，请重新填写 API Key 或先清除密钥。');
   const next={endpoint,models,apiKey:value.apiKey===undefined?saved.apiKey:value.apiKey.trim()};
   await mkdir(directory,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,file);saved=next;return publicSettings();
  },
  async catalog({refresh=false}={}){let models=[],warning=null;try{models=await codex.models({refresh});}catch(e){warning=e.message;}
   return{models:[...models.map(m=>({...m,provider:'codex',tools:true})),...saved.models.map(m=>({...m,provider:'doubao',reasoningEfforts:[]}))],doubaoConfigured:!!saved.apiKey&&saved.models.length>0,codexWarning:warning};
  },
  async status({provider='codex',refresh=false}={}){assert(['codex','doubao'].includes(provider),'模型服务不存在。');if(provider==='codex')return codex.status({refresh});return{provider,connected:!!saved.apiKey&&saved.models.length>0,message:saved.apiKey&&saved.models.length?'豆包已配置 · 发送时连接服务':'点击模型设置，填写豆包 API Key 和模型 ID。',configured:!!saved.apiKey&&saved.models.length>0};},
  async resolve({provider='codex',model='',effort=''}={}){
   assert(['codex','doubao'].includes(provider),'模型服务不存在。');assert(typeof model==='string'&&model.length<=200&&typeof effort==='string'&&effort.length<30,'模型选项无效。');
   if(provider==='codex'){
    let info;if(model||effort){const models=await codex.models();info=models.find(m=>m.id===model);assert(info,'当前 Codex 账户没有这个模型，请刷新模型列表。');assert(!effort||info.reasoningEfforts.includes(effort),'这个模型不支持所选思考强度。');}
    return{provider,model,effort:effort||info?.defaultReasoningEffort||'',label:info?.label||'Codex 默认',vision:info?.vision!==false,tools:true,generate:o=>codex.generate({...o,model,effort:effort||info?.defaultReasoningEffort||''})};
   }
   const info=saved.models.find(m=>m.id===model);assert(info&&saved.apiKey,'请先配置豆包 API Key 和模型 ID。','SERVICE_NOT_CONFIGURED');
   const settings=structuredClone(saved);return{...info,provider,model,effort:'',generate:o=>doubao.generate({...o,settings,model})};
  },
  async test({model}){const choice=await this.resolve({provider:'doubao',model});const result=await choice.generate({instructions:'直接简短回答。',prompt:'这是连接测试，请只回复：连接成功。',timeoutMs:30000});return{connected:true,model:result.model,message:'豆包连接成功'};}
 };
}
