import {assert, DomainError, id, refOf, RELATION_TYPES} from '../../packages/contracts/index.js';

export const KNOWLEDGE_KINDS = {concept:'概念',claim:'观点',question:'问题',argument:'论证'};
const MATERIAL_TYPES = new Set(['entry','source','knowledge','document','message']);
const RELATED_TYPES = new Set([...MATERIAL_TYPES,'persona']);

export function validateRef(ref) {
 assert(ref && typeof ref.targetId==='string' && ref.targetId.trim(), '引用缺少目标');
 assert(['live','pinned'].includes(ref.versionMode), '引用版本方式无效');
 if(ref.versionMode==='pinned')assert(Number.isInteger(ref.revision)&&ref.revision>0,'固定引用需要明确版本');
 assert(ref.quote==null || typeof ref.quote==='string','引用原文必须为文字');
 assert(ref.locator==null || (typeof ref.locator==='object'&&!Array.isArray(ref.locator)),'引用位置无效');
 return ref;
}

/** Pure, shared citation verification. Offsets are UTF-16 offsets into the stored body. */
export function validateCitation(ref, object, allowedSourceRefs) {
 const fail=(message,code='REFERENCE_UNAVAILABLE')=>({valid:false,code,message,text:null,warnings:[]});
 try { validateRef(ref); } catch(e) { return fail(e.message,e.code); }
 if(!object || object.id!==ref.targetId)return fail('找不到引用的原对象。');
 if(ref.versionMode==='pinned' && ref.revision!==object.revision)return fail('引用版本与提供的材料版本不一致。');
 if(!MATERIAL_TYPES.has(object.objectType) && object.objectType!=='persona')return fail('此类内容不能作为引用。');
 if(allowedSourceRefs!==undefined){
  if(!Array.isArray(allowedSourceRefs))return fail('资料范围格式无效。','INVALID_INPUT');
  if(object.objectType!=='source' || !allowedSourceRefs.some(r=>r.sourceId===object.id && r.revision===object.revision))return fail('这份材料或版本不在本次允许的资料范围内。');
  if(ref.versionMode!=='pinned')return fail('人物原文引用必须固定资料版本。');
 }
 const data=object.data||{}, locator=ref.locator||{}, warnings=[];
 if(object.deletedAt)warnings.push('原对象已删除，引用版本仍被保留。');
 if(object.objectType==='message'){
  if(data.status!=='complete')return fail('尚未定稿或已中断的消息不能引用。');
  if(!locator.discussionId || locator.discussionId!==data.discussionId)return fail('消息引用的讨论归属不一致。');
 }
 let text=String(data.body||'');
 if(object.objectType==='source' && data.parseStatus!=='ready'){
  if(ref.quote || Object.keys(locator).length || allowedSourceRefs!==undefined)return fail('材料尚未解析，暂时不能核验原文片段。');
  warnings.push('附件尚未解析；仅保留材料引用。');
 }
 if(locator.blockId!==undefined){
  if(object.objectType!=='document')return fail('段落定位仅适用于文稿。');
  const block=data.blocks?.find(b=>b.id===locator.blockId);
  if(!block || block.kind!=='text')return fail('引用段落不存在，或不是可核验的自有文字。');
  text=String(block.body||'');
 }
 if(locator.page!==undefined){
  const page=data.pages?.find(p=>p.number===locator.page);
  if(!page || typeof page.body!=='string')return fail('材料没有可核验的页码文本，无法定位这一页。');
  text=page.body;
 }
 if(locator.start!==undefined || locator.end!==undefined){
  if(!Number.isInteger(locator.start)||!Number.isInteger(locator.end)||locator.start<0||locator.end<=locator.start||locator.end>text.length)return fail('引用文字范围已超出原文。');
  text=text.slice(locator.start,locator.end);
  if(ref.quote!=null && ref.quote!==text)return fail('引用文字与指定位置的原文不匹配。');
 } else if(ref.quote!=null && ref.quote!=='') {
  if(!text.includes(ref.quote))return fail('引用文字与该版本的原文不匹配。');
  text=ref.quote;
 }
 return {valid:true,code:null,message:'引用已核验',text,warnings};
}

function validateBody(data){
 assert(data&&typeof data==='object','内容格式无效');
 assert(typeof data.body==='string','正文必须为文字');
 assert(data.title==null||typeof data.title==='string','标题必须为文字');
 assert(Array.isArray(data.citations||[]),'引用列表无效');
 for(const ref of data.citations||[])validateRef(ref);
}
export function validateKnowledge(data){
 validateBody(data);assert(Object.hasOwn(KNOWLEDGE_KINDS,data.kind),'请选择概念、观点、问题或论证');
 assert(data.body.trim() || data.title?.trim(),'写下一点内容，再保存。');
 if(data.premises!=null){assert(Array.isArray(data.premises),'前提必须为列表');for(const p of data.premises)assert(typeof p==='string','每项前提应为文字');}
 if(data.conclusion!=null)assert(typeof data.conclusion==='string','结论必须为文字');
 return data;
}
export function validateDocument(data){
 validateBody(data);assert(Array.isArray(data.blocks||[]),'文稿段落无效');
 const seen=new Set();
 for(const block of data.blocks||[]){
  assert(typeof block.id==='string'&&block.id&&!seen.has(block.id),'文稿段落身份不能为空或重复');seen.add(block.id);
  assert(['text','reference'].includes(block.kind),'文稿段落类型无效');
  if(block.kind==='text')assert(typeof block.body==='string','段落正文必须为文字');else validateRef(block.ref);
 }
 assert(data.title?.trim()||data.body.trim()||data.blocks?.length,'写下一点内容，再保存。');
 return data;
}
export function validateSource(data){
 validateBody(data);assert(['text','markdown','link','attachment'].includes(data.format),'材料格式无效');
 assert(['ready','unparsed'].includes(data.parseStatus),'解析状态无效');
 assert(Array.isArray(data.attachmentIds)&&data.attachmentIds.every(v=>typeof v==='string'),'附件列表无效');
 if(data.url){let url;try{url=new URL(data.url);}catch{}assert(url&&['https:','http:'].includes(url.protocol),'链接需要以 http:// 或 https:// 开头。');}
 if(data.format==='link')assert(data.url,'请填写材料链接。');
 assert(data.body.trim()||data.title?.trim()||data.attachmentIds.length||data.url,'请填写或导入材料。');
 if(data.parseStatus==='ready')assert(data.body.trim(),'材料未转成可检索文字时，应保留“未解析”状态。');
 return data;
}

export function validateRelation(data, fromObject, toObject){
 assert(data&&Object.hasOwn(RELATION_TYPES,data.kind),'关联类型无效');validateRef(data.from);validateRef(data.to);
 for(const [ref,obj] of [[data.from,fromObject],[data.to,toObject]]){const result=validateCitation(ref,obj);assert(result.valid,result.message,result.code);}
 const from=fromObject.objectType,to=toObject.objectType,kind=toObject.data?.kind;
 assert(!fromObject.deletedAt&&!toObject.deletedAt,'请先恢复被删除的内容，再建立关联。');
 if(data.kind==='relatedTo')assert(RELATED_TYPES.has(from)&&RELATED_TYPES.has(to),'这些内容不能建立关联');
 else {
  assert(MATERIAL_TYPES.has(from),'关系起点需要是材料、记录、知识项、文稿或已完成消息。');
  if(['supports','refutes'].includes(data.kind))assert((to==='knowledge'&&['claim','argument'].includes(kind))||(to==='entry'&&kind==='prediction'),'支持或质疑的目标应为观点、论证或预言。');
  if(data.kind==='defines')assert(to==='knowledge'&&kind==='concept','定义的目标应为概念。');
  if(data.kind==='premiseOf'){
   assert(to==='knowledge'&&kind==='argument','前提的目标应为论证。');
   assert(from==='entry'||(from==='knowledge'&&fromObject.data.kind==='claim'),'前提应来自一个观点或记录中的判断。');
  }
  if(data.kind==='exampleOf')assert(to==='knowledge'&&['concept','claim'].includes(kind),'实例的目标应为概念或观点。');
 }
 assert(data.explanation==null||typeof data.explanation==='string','关联说明必须为文字');
 return data;
}
export function relationKey(data){
 const endpoint=ref=>JSON.stringify([ref.targetId,ref.locator||null]);
 const ends=[endpoint(data.from),endpoint(data.to)];
 if(data.kind==='relatedTo')ends.sort();
 return `${data.kind}:${ends.join('→')}`;
}
export function prepareRelationChange(data, fromObject, toObject, existing=[]){
 validateRelation(data,fromObject,toObject);
 const canonical=structuredClone(data);
 if(canonical.kind==='relatedTo' && canonical.from.targetId>canonical.to.targetId)[canonical.from,canonical.to]=[canonical.to,canonical.from];
 assert(!existing.some(r=>!r.deletedAt&&relationKey(r.data||r)===relationKey(canonical)),'这两个内容之间已经有这条关联。');
 return {id:id('relation'),objectType:'relation',expectedRevision:0,data:canonical};
}

export function referencesIn(object){
 const data=object.data||{}, refs=[];
 for(const ref of data.citations||[])refs.push({ref,role:'引用'});
 for(const block of data.blocks||[])if(block.kind==='reference'&&block.ref)refs.push({ref:block.ref,role:'文稿引用块',blockId:block.id});
 if(object.objectType==='relation'){
  if(data.from)refs.push({ref:data.from,role:'关系起点'});
  if(data.to)refs.push({ref:data.to,role:'关系终点'});
 }
 if(object.objectType==='citation'&&data.ref)refs.push({ref:data.ref,role:'引用'});
 if(object.objectType==='predictionReview'&&data.predictionRef)refs.push({ref:data.predictionRef,role:'评估预言'});
 if(object.objectType==='discussion')for(const ref of data.contextRefs||[])refs.push({ref,role:'讨论上下文'});
 return refs;
}
export function incomingRefs(targetId, objects){
 return objects.filter(o=>!o.deletedAt&&o.id!==targetId).flatMap(object=>referencesIn(object).filter(({ref})=>ref.targetId===targetId).map(item=>({object,...item})));
}

export function referenceStatus(ref, snapshot, latest){
 const result=validateCitation(ref,snapshot);
 return {...result,deleted:!!latest?.deletedAt,newer:ref.versionMode==='pinned'&&!!latest&&latest.revision>ref.revision,currentRevision:latest?.revision??null};
}

/** Stateless preparation; A0 adds the receipt and commits all changes atomically. */
export function prepareAdoptionChange({target=null,objectType='knowledge',data,messageRef,newId}){
 assert(messageRef,'采纳需要保留讨论消息来源');validateRef(messageRef);
 assert(messageRef.versionMode==='pinned' && messageRef.locator?.discussionId,'采纳需固定讨论与消息版本');
 if(target){assert(!target.deletedAt,'请先恢复目标内容');objectType=target.objectType;}
 assert(['knowledge','document'].includes(objectType),'此采纳目标不属于知识模块');
 const next=structuredClone(data||target?.data||{});
 next.citations=[...(next.citations||[])];
 if(!next.citations.some(r=>r.targetId===messageRef.targetId&&r.revision===messageRef.revision))next.citations.push(structuredClone(messageRef));
 if(objectType==='knowledge')validateKnowledge(next);else validateDocument(next);
 return {id:target?.id||newId||id(objectType),objectType,expectedRevision:target?.revision||0,data:next};
}
export function prepareUndoChange(current,before,expectedRevision){
 assert(current&&['knowledge','document'].includes(current.objectType),'找不到可撤销的知识内容');
 assert(current.revision===expectedRevision,'采纳后已有其他修改；为保护后续内容，无法直接撤销。','VERSION_CONFLICT',{expectedRevision,currentRevision:current.revision});
 if(before)assert(before.id===current.id&&before.objectType===current.objectType,'撤销前的版本不属于该内容');
 return {id:current.id,objectType:current.objectType,expectedRevision:current.revision,data:structuredClone(before?.data||current.data),deleted:before?!!before.deletedAt:true};
}

export function outlineOf(body){
 let fenced=false;
 return String(body).split('\n').flatMap((line,index)=>{
  if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;return [];}
  const match=!fenced&&/^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  return match?[{id:`heading-${index}`,level:match[1].length,title:match[2],line:index}]:[];
 });
}

/** Preserve stable paragraph identities for unchanged Markdown sections across edits. */
export function reconcileTextBlocks(body, previous=[]){
 const pools=new Map(),old=previous.filter(b=>b.kind==='text'),used=new Set();
 for(const block of old){
  if(!pools.has(block.body))pools.set(block.body,[]);pools.get(block.body).push(block.id);
 }
 const next=String(body).split(/\n\s*\n/).filter(s=>s.trim()).map(text=>{
  const matched=pools.get(text)?.shift();if(matched)used.add(matched);return{id:matched||null,kind:'text',body:text};
 });
 // A changed paragraph retains its identity where an old unmatched paragraph occupied
 // that position. Exact matches were claimed first, so reordering does not steal IDs.
 next.forEach((block,index)=>{if(!block.id){const prior=old[index];if(prior&&!used.has(prior.id)){block.id=prior.id;used.add(prior.id);}else block.id=id('paragraph');}});
 return next;
}

export function versionDifference(previous,current){
 const before=String(previous?.data?.body||''),after=String(current?.data?.body||'');
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let endBefore=before.length,endAfter=after.length;
 while(endBefore>start&&endAfter>start&&before[endBefore-1]===after[endAfter-1]){endBefore--;endAfter--;}
 return {changed:before!==after,removed:before.slice(start,endBefore),added:after.slice(start,endAfter),start};
}
