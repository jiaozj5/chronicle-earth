import {createHash} from 'node:crypto';
import {assert} from '../../packages/contracts/index.js';
import {LIBRARY_TOOLS,validateSchema} from './schema.js';
const names=['book_outline','book_read','book_search','selection_resolve','annotation_create','annotation_get','annotation_list','annotation_update','annotation_delete','annotation_restore','annotation_read_context','reader_get_context','reader_navigate','reader_set_selection','reader_set_view','reader_set_preferences'];
const labels={book_outline:'读取目录',book_read:'阅读原文',book_search:'搜索书内内容',selection_resolve:'核对选区',annotation_create:'保存批注',annotation_get:'读取批注',annotation_list:'查找批注',annotation_update:'修改批注',annotation_delete:'移入批注回收站',annotation_restore:'恢复批注',annotation_read_context:'核对批注原文',reader_get_context:'读取阅读位置',reader_navigate:'跳转阅读位置',reader_set_selection:'选中原文',reader_set_view:'切换阅读视图',reader_set_preferences:'调整阅读字号'};
const bound=['publicationId','renditionId','sessionId','requestId'];
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function readingTools({workspace,library,publicationId,renditionId,sessionId,questionId,signal,onAction=()=>{}}){
 const definitions=LIBRARY_TOOLS.filter(t=>names.includes(t.name)&&(!t.name.startsWith('reader_')||sessionId)).map(t=>{const schema=structuredClone(t.inputSchema);for(const k of bound)delete schema.properties[k];schema.required=schema.required.filter(k=>!bound.includes(k));return{...t,description:t.description+' 仅限当前书籍，pageIndex 从 0 开始。',inputSchema:schema};});let count=0,tail=Promise.resolve();const receipts=new Map();
 async function run(name,args,callId){
  assert(!signal?.aborted,'已停止生成','CANCELLED');assert(++count<=16,'本轮已调用 16 次工具，请继续追问。','TOOL_LIMIT');const tool=definitions.find(t=>t.name===name);assert(tool,'未开放此操作。','OPERATION_NOT_ALLOWED');validateSchema(tool.inputSchema,args);
  const spec=LIBRARY_TOOLS.find(t=>t.name===name),input={...args};for(const[k,v]of Object.entries({publicationId,renditionId,sessionId}))if(spec.inputSchema.properties[k])input[k]=v;
  if(name.startsWith('annotation_')&&args.id){const note=workspace.get(args.id,{includeDeleted:true});assert(note.objectType==='annotation'&&note.data.publicationId===publicationId,'批注不属于当前书籍。','OPERATION_NOT_ALLOWED');}
  if(name.startsWith('reader_')){const state=await library.call('reader_get_state',{sessionId});assert(state?.publicationId===publicationId&&state.renditionId===renditionId,'阅读窗口已切换书籍或版本，请重新提问。','READER_UNAVAILABLE');}
  if(!tool.readOnly)input.requestId='chat_tool_'+createHash('sha256').update(JSON.stringify(canonical({questionId,name,input}))).digest('hex').slice(0,40);
  const key=JSON.stringify(canonical({name,input}));if(receipts.has(key))return receipts.get(key);
  const action={id:callId||'tool_'+count,name,label:labels[name],arguments:args,status:'running',readOnly:tool.readOnly};await onAction(action);
  try{assert(!signal?.aborted,'已停止生成','CANCELLED');const result=await library.call(name,input);const raw=JSON.stringify(result),bounded=raw.length>40000?{truncated:true,message:'结果过长，请使用页码、offset/limit 或搜索缩小范围。',preview:raw.slice(0,38000)}:result;
   const receipt=Object.fromEntries(['id','annotationId','operationId','operationRevision','revision','pageIndex','command'].filter(k=>result[k]!==undefined).map(k=>[k,result[k]]));await onAction({...action,status:'complete',result:receipt});const answer={success:true,result:bounded};receipts.set(key,answer);return answer;
  }catch(e){await onAction({...action,status:'failed',error:e.message});return{success:false,error:{code:e.code||'TOOL_FAILED',message:e.code?e.message:'操作失败，未确认完成。'}};}
 }
 return{definitions,call(name,args,callId){const task=tail.then(()=>run(name,args,callId)).catch(e=>({success:false,error:{code:e.code||'TOOL_FAILED',message:e.code?e.message:'工具调用失败。'}}));tail=task.then(()=>{});return task;}};
}
