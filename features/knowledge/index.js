import {el,button,field,renderMarkdown,formatDate,emptyState,errorText} from '../../packages/ui/index.js';
import {id,titleOf,refOf,RELATION_TYPES,TYPE_LABELS} from '../../packages/contracts/index.js';
import {KNOWLEDGE_KINDS,validateCitation,validateKnowledge,validateDocument,validateSource,prepareRelationChange,incomingRefs,referenceStatus,outlineOf,reconcileTextBlocks,versionDifference} from './service.js';

const editingSessions=new Map();
const lastSelected=new Map();
const typeName=o=>o.objectType==='knowledge'?KNOWLEDGE_KINDS[o.data.kind]:TYPE_LABELS[o.objectType];
const copy=value=>structuredClone(value);
// Unsaved edits survive route changes in this session, and never claim disk persistence.
if(typeof window!=='undefined')window.addEventListener('beforeunload',event=>{
 if([...editingSessions.values()].some(session=>session.dirty&&JSON.stringify(session.data)!==JSON.stringify(session.draftObject?.data?.content))){event.preventDefault();event.returnValue='';}
});

export async function mount(container,ctx){
 const sources=ctx.params?.mode==='sources';
 const mode=sources?'sources':'knowledge';
 const state={object:null,data:null,type:sources?'source':'knowledge',editing:false,dirty:false,busy:false,historical:false,items:[],total:0,query:'',offset:0,filter:'all',disposed:false,requestId:null,tab:'body',listToken:0,renderToken:0,draftKey:null,draftObject:null,draftId:null,persistedDraft:null,lastDraftPayload:''};
 const remembered=editingSessions.get(mode);
 const list=el('div',{className:'kn-library-items','aria-live':'polite'});
 const listFooter=el('div',{className:'kn-library-footer'});
 const detail=el('section',{className:'kn-detail','aria-label':sources?'材料内容':'知识内容'});
 const search=el('input',{type:'search',placeholder:sources?'搜索材料…':'搜索文稿、概念、观点…','aria-label':sources?'搜索材料':'搜索知识'});
 const filter=el('select',{'aria-label':'筛选内容类型'},...(sources?[["all","全部材料"],["ready","可检索文字"],["unparsed","未解析附件"],["trash","已删除"]]:[["all","全部内容"],["document","文稿"],["concept","概念"],["claim","观点"],["question","问题"],["argument","论证"],["trash","已删除"]]).map(([value,label])=>el('option',{value},label)));
 const newKind=el('select',{'aria-label':'新建内容类型'},...(sources?[["text","文字 / 摘录"],["markdown","Markdown"],["link","链接"],["attachment","附件"]]:[["document","文稿"],...Object.entries(KNOWLEDGE_KINDS)]).map(([value,label])=>el('option',{value},label)));
 const introduction=el('div',{className:'kn-tools'},el('p',{className:'muted small'},sources?'原材料与自己的分析分别保留，引用时选择明确版本。':'无需选择时间地点，直接开始写作与思考。'),el('div',{className:'row'},newKind,button(sources?'添加材料':'新建',()=>startNew(newKind.value),'button primary')));
 const library=el('aside',{className:'kn-library','aria-label':sources?'材料目录':'知识目录'},el('div',{className:'kn-library-controls'},search,filter),list,listFooter);
 container.replaceChildren(el('div',{className:'kn-root'},introduction,el('div',{className:'kn-layout'},library,detail)));
 let queryTimer,draftTimer,draftSaving=null;
 search.addEventListener('input',()=>{clearTimeout(queryTimer);queryTimer=setTimeout(()=>{state.query=search.value;loadList();},180);});
 filter.addEventListener('change',()=>{state.filter=filter.value;loadList();});

 function tell(error){ctx.notify(errorText(error),'error');}
 function draftIsCurrent(){return !!state.draftObject&&JSON.stringify(state.data)===JSON.stringify(state.draftObject.data.content);}
 function saveMemory(){if(state.data){const session={object:copy(state.object),data:copy(state.data),type:state.type,editing:state.editing,dirty:state.dirty,historical:state.historical,tab:state.tab,scroll:detail.scrollTop,draftKey:state.draftKey,mode,draftObject:copy(state.draftObject),draftId:state.draftId,lastDraftPayload:state.lastDraftPayload};editingSessions.set(mode,session);if(state.dirty&&!state.historical){editingSessions.set(state.object?`object:${state.object.id}`:state.draftKey,session);}}}
 function scheduleDraft(){clearTimeout(draftTimer);draftTimer=setTimeout(()=>{if(state.busy){scheduleDraft();return;}flushDraft().catch(e=>{const status=detail.querySelector('.kn-save-status');if(status)status.textContent='草稿尚未保存 · '+errorText(e);tell(e);});},650);}
 function dirty(){state.dirty=true;state.requestId=null;saveMemory();const status=detail.querySelector('.kn-save-status');if(status)status.textContent='正在准备保存草稿…';scheduleDraft();}
 async function flushDraft(){
  clearTimeout(draftTimer);
  if(draftSaving)await draftSaving;
  if(!state.data||!state.dirty||state.historical)return;
  const draftData={draftKind:mode,targetType:state.type,editingId:state.object?.id||null,editingRevision:state.object?.revision||null,title:state.data.title||'',body:state.data.body||'',content:copy(state.data)};
  const payload=JSON.stringify(draftData);if(payload===state.lastDraftPayload)return;
  state.draftId??=state.draftObject?.id||id('draft');
  const change={id:state.draftId,objectType:'draft',expectedRevision:state.draftObject?.revision||0,data:draftData};
  if(state.draftPending?.payload!==payload)state.draftPending={payload,requestId:id('draftsave')};
  const requestId=state.draftPending.requestId;
  draftSaving=(async()=>{
   const result=await ctx.api.commit([change],requestId);state.draftObject=result.objects.find(o=>o.id===change.id);state.lastDraftPayload=payload;state.draftPending=null;saveMemory();
   if(!state.disposed){const status=detail.querySelector('.kn-save-status');if(status)status.textContent=draftIsCurrent()?'草稿已保存在本机 · 保存后成为正式版本':'新输入正在保存草稿…';if(!draftIsCurrent())scheduleDraft();}
  })();
  try{await draftSaving;}finally{draftSaving=null;}
  if(state.dirty&&!draftIsCurrent())await flushDraft();
 }
 async function readDrafts(){
  const result=await ctx.api.list({objectType:'draft',draftKind:mode,limit:100000});
  return result.items.filter(o=>o.data.draftKind===mode&&o.data.content);
 }
 async function resumeDraft(draft){
  if(state.busy)return;await flushDraft();saveMemory();
  let target=null;if(draft.data.editingId){try{target=await ctx.api.get(draft.data.editingId,{revision:draft.data.editingRevision,includeDeleted:true});}catch(e){tell(e);return;}}
  state.object=target;state.type=draft.data.targetType;state.data=copy(draft.data.content);state.dirty=true;state.editing=true;state.historical=false;state.tab='body';state.draftObject=draft;state.draftId=draft.id;state.lastDraftPayload=JSON.stringify(draft.data);state.draftKey=target?null:'new:'+draft.id;state.requestId=null;saveMemory();renderDetail();renderList();
 }
 function onBeforeUnload(e){if(state.dirty&&JSON.stringify(state.data)!==JSON.stringify(state.draftObject?.data?.content)){e.preventDefault();e.returnValue='';}}
 function onKeyboard(e){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&container.isConnected){e.preventDefault();save();}}
 window.addEventListener('beforeunload',onBeforeUnload);
 container.addEventListener('keydown',onKeyboard);

 async function loadList(append=false){
  const token=++state.listToken;
  if(!append){state.offset=0;list.replaceChildren(el('p',{className:'muted kn-list-note'},'正在读取…'));}
  try{
   const query={objectTypes:sources?['source']:['document','knowledge'],q:state.query,limit:100,offset:append?state.offset:0,onlyDeleted:state.filter==='trash',summary:true};
   if(!sources&&state.filter==='document'){query.objectTypes=['document'];}
   else if(!sources&&Object.hasOwn(KNOWLEDGE_KINDS,state.filter)){query.objectTypes=['knowledge'];query.kind=state.filter;}
   else if(sources&&['ready','unparsed'].includes(state.filter))query.parseStatus=state.filter;
   const [result,drafts]=await Promise.all([ctx.api.list(query),readDrafts()]);if(state.disposed||token!==state.listToken)return;
   state.savedDrafts=drafts;
   state.items=append?[...state.items,...result.items]:result.items;state.offset=(append?state.offset:0)+result.items.length;state.total=result.total;
   renderList();
  }catch(e){if(token===state.listToken){list.replaceChildren(el('p',{className:'error kn-list-note'},errorText(e)),button('重试',()=>loadList(append)));}}
 }
 function renderList(){
  const items=state.items.filter(o=>state.filter==='all'||state.filter==='trash'||o.objectType===state.filter||o.data.kind===state.filter||o.data.parseStatus===state.filter);
  list.replaceChildren(...items.map(o=>{
   const item=button('',()=>open(o.id),'kn-list-item'+(state.object?.id===o.id?' is-current':''));
   item.setAttribute('aria-current',state.object?.id===o.id?'true':'false');
   item.append(el('div',{className:'kn-list-meta'},el('span',{},typeName(o)),el('span',{},`v${o.revision}`)),el('strong',{},titleOf(o)),el('p',{},o.data.author||o.data.url||(o.data.bodyLength?`${o.data.bodyLength.toLocaleString()} 字符`:(o.objectType==='source'?'原附件 · 未解析':'等待继续书写'))),el('time',{className:'small muted'},formatDate(o.updatedAt)));
   return item;
  }));
  for(const draft of [...(state.savedDrafts||[])].reverse()){list.prepend(button(`草稿 · ${titleOf(draft)}`,()=>resumeDraft(draft).catch(tell),'kn-list-item kn-unsaved'));}
  if(!items.length)list.append(el('p',{className:'muted kn-list-note'},state.items.length?'当前批次暂无匹配内容，可继续加载。':'还没有符合条件的内容。'));
  listFooter.replaceChildren(el('span',{className:'small muted'},`${state.total} 项内容`));
  if(state.offset<state.total)listFooter.append(button('继续加载',()=>loadList(true),'button ghost'));
 }

 async function startNew(kind=sources?'text':'document',seedRefs=[]){
  if(state.busy)return;try{await flushDraft();}catch(e){tell(e);return;}saveMemory();state.object=null;state.draftKey='new:'+id(mode);state.draftObject=null;state.draftId=null;state.lastDraftPayload='';state.type=sources?'source':kind==='document'?'document':'knowledge';state.historical=false;state.editing=true;state.dirty=seedRefs.length>0;state.tab='body';
  state.data={title:'',body:'',citations:copy(seedRefs)};
  if(state.type==='knowledge')Object.assign(state.data,{kind,premises:[],conclusion:''});
  if(state.type==='document')state.data.blocks=[];
  if(state.type==='source')Object.assign(state.data,{format:kind,parseStatus:kind==='attachment'||kind==='link'?'unparsed':'ready',attachmentIds:[],url:'',author:''});
  state.requestId=null;saveMemory();renderDetail();await loadList();if(seedRefs.length)dirty();
  detail.querySelector('textarea')?.focus();
 }
 async function open(objectId,revision){
  if(state.busy)return;try{await flushDraft();}catch(e){tell(e);return;}saveMemory();const token=++state.renderToken;
  detail.replaceChildren(el('p',{className:'muted'},'正在打开…'));
  try{
   const object=await ctx.api.get(objectId,{revision,includeDeleted:true});
   if(state.disposed||token!==state.renderToken)return;
   if(object.objectType==='draft'&&object.data.draftKind===mode){await resumeDraft(object);return;}
   // Retain unsaved edits when returning from a linked object.
   const memory=editingSessions.get(`object:${objectId}`);
   state.object=object;state.draftKey=null;state.draftObject=null;state.draftId=null;state.lastDraftPayload='';state.type=object.objectType;state.data=copy(object.data);state.dirty=false;state.editing=false;state.historical=!!revision;state.tab='body';state.requestId=null;
   if(memory?.dirty&&!revision){Object.assign(state,{object:copy(memory.object),data:copy(memory.data),dirty:memory.dirty,editing:memory.editing,draftObject:copy(memory.draftObject),draftId:memory.draftId,lastDraftPayload:memory.lastDraftPayload});}
   else if(!revision){const persisted=state.savedDrafts?.find(d=>d.data.editingId===objectId);if(persisted){state.object=await ctx.api.get(objectId,{revision:persisted.data.editingRevision,includeDeleted:true});state.data=copy(persisted.data.content);state.dirty=true;state.editing=true;state.draftObject=persisted;state.draftId=persisted.id;state.lastDraftPayload=JSON.stringify(persisted.data);}}
   lastSelected.set(mode,objectId);saveMemory();renderDetail();renderList();
  }catch(e){detail.replaceChildren(emptyState('暂时无法打开',errorText(e),button('重试',()=>open(objectId,revision))));}
 }
 function keepObjectDraft(){saveMemory();}
 // All navigation from this module records a recoverable in-session editing state.
 function goObject(ref){keepObjectDraft();saveMemory();ctx.openObject(ref.targetId,ref.versionMode==='pinned'?ref.revision:undefined);}

 async function save(){
  if(state.busy||!state.data||state.historical||state.object?.deletedAt)return;
  state.busy=true;let finishSave;state.saveDone=new Promise(resolve=>{finishSave=resolve;});const saveButton=detail.querySelector('[data-save]');if(saveButton)saveButton.disabled=true;
  const status=detail.querySelector('.kn-save-status');if(status)status.textContent='正在保存…';
  try{
   await flushDraft();clearTimeout(draftTimer);const data=copy(state.data);
   if(state.type==='document'){
    const referenceBlocks=(data.blocks||[]).filter(b=>b.kind==='reference');
    data.blocks=[...reconcileTextBlocks(data.body,data.blocks||[]),...referenceBlocks];validateDocument(data);
   }else if(state.type==='source'){if(['text','markdown','link'].includes(data.format))data.parseStatus=data.body.trim()?'ready':'unparsed';validateSource(data);}
   else validateKnowledge(data);
   state.requestId??=id('save');
   const change={id:state.object?.id||id(state.type),objectType:state.type,expectedRevision:state.object?.revision||0,data};
   // Retrying the same visible draft reuses its object id and request id.
   if(state.pending&&state.pending.requestId===state.requestId)change.id=state.pending.id;
   const submitted=JSON.stringify(state.data);let changes=[change];if(state.draftObject)changes.push({id:state.draftObject.id,objectType:'draft',expectedRevision:state.draftObject.revision,data:state.draftObject.data,deleted:true});
   if(state.pending?.requestId===state.requestId&&state.pending.raw===submitted)changes=copy(state.pending.changes);
   else state.pending={requestId:state.requestId,id:change.id,raw:submitted,changes:copy(changes)};
   const result=await ctx.api.commit(changes,state.requestId);
   const saved=result.objects.find(o=>o.id===change.id),changedDuringSave=JSON.stringify(state.data)!==submitted;
   if(state.draftKey)editingSessions.delete(state.draftKey);
   state.object=saved;state.draftKey=null;state.draftObject=null;state.draftId=null;state.lastDraftPayload='';if(!changedDuringSave)state.data=copy(saved.data);state.dirty=changedDuringSave;state.requestId=null;state.pending=null;state.editing=changedDuringSave;
   editingSessions.delete(`object:${saved.id}`);lastSelected.set(mode,saved.id);saveMemory();if(changedDuringSave)await flushDraft();if(!state.disposed){renderDetail();await loadList();}ctx.notify(changedDuringSave?'已保存提交时的版本；新输入保留为草稿。':'已保存');
  }catch(e){
   if(status)status.textContent=e.code==='VERSION_CONFLICT'?'存在较新版本 · 编辑内容仍保留':'保存未完成 · 内容仍保留';
   tell(e);
   if(e.code==='VERSION_CONFLICT')showConflict();
  }finally{state.busy=false;finishSave();state.saveDone=null;if(saveButton)saveButton.disabled=false;}
 }

 function renderDetail(){
  ++state.renderToken;detail.replaceChildren();
  if(!state.data){detail.append(emptyState(sources?'把原材料收进来':'给思考一个可以继续的地方',sources?'文字、摘录、Markdown、链接和附件都可以保留。材料的解析范围始终可见。':'你可以独立写一份文稿，也可以从一个概念、观点或问题开始，无需选择时间与地点。',button(sources?'添加第一份材料':'开始写一份文稿',()=>startNew(sources?'text':'document'),'button primary')));return;}
  const object=state.object,data=state.data,readonly=state.historical||!!object?.deletedAt;
  const heading=el('div',{className:'kn-detail-heading'},el('div',{className:'row'},el('span',{className:'badge'},state.type==='knowledge'?KNOWLEDGE_KINDS[data.kind]:TYPE_LABELS[state.type]),el('span',{className:'muted small'},object?`版本 ${object.revision} · ${formatDate(object.updatedAt)}`:'尚未保存')));
  const actions=el('div',{className:'row'});
  if(!readonly){
   actions.append(button(state.editing?'阅读预览':'编辑',()=>{state.editing=!state.editing;saveMemory();renderDetail();},'button ghost'));
   const saveButton=button('保存',save,'button primary');saveButton.dataset.save='';actions.append(saveButton);
   if(object)actions.append(button('讨论',()=>{keepObjectDraft();saveMemory();if(state.dirty){ctx.notify('请先保存当前修改，再以该版本讨论。');return;}ctx.navigate('personas',{contextRefs:[refOf(object)]});},'button ghost'));
  }
  if(state.historical)actions.append(button('返回当前版本',()=>open(object.id),'button'));
  if(object?.deletedAt)actions.append(button('恢复内容',async()=>{try{await ctx.api.restore(object);await open(object.id);await loadList();ctx.notify('已恢复原内容与身份');}catch(e){tell(e);}},'button primary'));
  heading.append(actions);detail.append(heading);
  if(readonly)detail.append(el('div',{className:'kn-notice'},object?.deletedAt?'这份内容已删除。引用与版本仍然保留，可以恢复。':'正在阅读固定历史版本；此处的修改不会覆盖当前内容。'));
  if(state.editing&&!readonly){
   const title=el('input',{className:'kn-title-input',value:data.title||'',placeholder:sources?'材料名称（可稍后补充）':'标题（可稍后补充）','aria-label':'标题'});title.addEventListener('input',()=>{data.title=title.value;dirty();});detail.append(title);
  }else detail.append(el('h2',{className:'kn-content-title'},data.title||titleOf({data})||'未命名'));
  const saveStatus=el('p',{className:'kn-save-status small muted',role:'status'},state.dirty?(draftIsCurrent()?'草稿已保存在本机 · 保存后成为正式版本':'正在准备保存草稿…'):object?'此版本已保存在本机':'写下内容后保存 · Ctrl / ⌘ + S');detail.append(saveStatus);
  const tabs=el('div',{className:'kn-tabs',role:'tablist'});
  for(const [key,label] of [['body','正文'],['connections','材料与关联'],['history','修订']]){
   if(key==='history'&&!object)continue;
   const tab=button(label,()=>{state.tab=key;saveMemory();renderDetail();},'kn-tab');tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(state.tab===key));tabs.append(tab);
  }detail.append(tabs);
  const panel=el('div',{className:'kn-tab-panel',role:'tabpanel'});detail.append(panel);
  if(state.tab==='history'){renderHistory(panel);return;}
  if(state.tab==='connections'){renderConnections(panel,readonly);return;}
  if(state.type==='source')renderSourceFields(panel,readonly);
  if(state.type==='knowledge'&&state.editing&&!readonly){
   const kind=el('select',{},...Object.entries(KNOWLEDGE_KINDS).map(([value,label])=>el('option',{value,selected:data.kind===value},label)));kind.addEventListener('change',()=>{data.kind=kind.value;dirty();renderDetail();});panel.append(field('内容类型',kind));
  }
  renderBody(panel,readonly);
  if(state.type==='knowledge'&&data.kind==='argument')renderArgument(panel,readonly);
  if(state.type==='document')renderReferenceBlocks(panel,readonly);
  if(data.citations?.length){panel.append(el('h3',{className:'kn-section-title'},'引用材料'));const refs=el('div',{className:'kn-citations'});panel.append(refs);data.citations.forEach((ref,i)=>renderCitation(refs,ref,!readonly?()=>{data.citations.splice(i,1);dirty();renderDetail();}:null,!readonly?newRef=>{data.citations[i]=newRef;dirty();renderDetail();}:null));}
  if(!readonly)panel.append(button('添加引用',()=>pickReference(ref=>{data.citations??=[];data.citations.push(ref);dirty();renderDetail();}),'button ghost'));
  if(object&&!readonly)panel.append(el('div',{className:'kn-footer-actions'},button('移入回收站',async()=>{if(state.dirty){ctx.notify('请先保存当前修改，再移入回收站。');return;}showDelete();},'button ghost danger')));
 }

 function renderBody(panel,readonly){
  const data=state.data;
  if(state.editing&&!readonly){
   const body=el('textarea',{className:'kn-body-editor',value:data.body||'',placeholder:state.type==='source'?'粘贴原材料或摘录；自己的分析可以另建观点。':'先写下来。支持 Markdown 标题、表格，以及 $行内公式$ 和 $$块级公式$$。','aria-label':state.type==='source'?'材料原文':'正文',rows:16});
   body.addEventListener('input',()=>{data.body=body.value;dirty();});panel.append(body,el('p',{className:'small muted kn-editor-hint'},'Markdown · 标题用 #，表格用 |，公式用 $…$ 或 $$…$$。引用材料在正文下方单独保留。'));
  }else{
   const body=renderMarkdown(data.body||'');body.classList.add('kn-prose');
   const headings=outlineOf(data.body);const actual=[...body.querySelectorAll('h1,h2,h3,h4,h5,h6')];actual.forEach((h,i)=>{h.id=`kn-${headings[i]?.id||'h-'+i}`;});
   if(headings.length){const outline=el('details',{className:'kn-outline',open:true},el('summary',{},`目录 · ${headings.length} 节`));
    const build=(items,parentLevel=0)=>{const root=el('div',{className:'kn-outline-level'});let index=0;while(index<items.length){const h=items[index],children=[];index++;while(index<items.length&&items[index].level>h.level)children.push(items[index++]);const link=button(h.title,()=>detail.querySelector(`#kn-${h.id}`)?.scrollIntoView({behavior:'instant',block:'start'}),'kn-outline-link');if(children.length){root.append(el('details',{open:true},el('summary',{},link),build(children,h.level)));}else root.append(link);}return root;};
    outline.append(build(headings));panel.append(outline);
   }
   if(!data.body?.trim())body.append(el('p',{className:'muted'},state.type==='source'?'尚无可阅读的文字。可以保留原附件，或添加自己核对过的摘录。':'正文尚未填写。'));
   panel.append(body);
  }
 }
 function renderArgument(panel,readonly){
  const data=state.data;panel.append(el('h3',{className:'kn-section-title'},'论证结构'));
  if(state.editing&&!readonly){
   const premises=el('textarea',{rows:4,value:(data.premises||[]).join('\n'),placeholder:'每行写一个前提','aria-label':'论证前提'});premises.addEventListener('input',()=>{data.premises=premises.value.split('\n').filter(s=>s.trim());dirty();});
   const conclusion=el('textarea',{rows:3,value:data.conclusion||'',placeholder:'写下结论','aria-label':'论证结论'});conclusion.addEventListener('input',()=>{data.conclusion=conclusion.value;dirty();});panel.append(el('div',{className:'stack'},field('前提',premises),field('结论',conclusion)));
  }else{panel.append(el('ol',{className:'kn-premises'},...(data.premises||[]).map(p=>el('li',{},p))),el('div',{className:'kn-conclusion'},el('strong',{},'结论'),renderMarkdown(data.conclusion||'尚未填写')));}
 }
 function renderSourceFields(panel,readonly){
  const data=state.data;
  panel.append(el('div',{className:'kn-source-state'},el('span',{className:'badge'},data.parseStatus==='ready'?'可检索正文':'未解析 / 无正文'),el('span',{className:'small muted'},data.format==='link'?'外链仅保留地址与已填写摘录；未下载网页全文。':data.parseStatus==='unparsed'?'原文件已保留；未解析内容不会供人物当作全文使用。':'人物可以在明确选定的资料版本内检索这些文字。')));
  if(state.editing&&!readonly){
   const author=el('input',{value:data.author||'',placeholder:'作者、书目或出处'});author.addEventListener('input',()=>{data.author=author.value;dirty();});panel.append(field('作者 / 出处',author));
   if(data.format==='link'){const url=el('input',{type:'url',value:data.url||'',placeholder:'https://…'});url.addEventListener('input',()=>{data.url=url.value;dirty();});panel.append(field('原始链接',url));}
   const upload=el('input',{type:'file','aria-label':'导入材料文件'});upload.addEventListener('change',()=>importFile(upload.files?.[0]));panel.append(field('导入文件（文本 / Markdown 自动读取，其余保留附件）',upload));
   if(data.format==='attachment'){const parsed=el('input',{type:'checkbox',checked:data.parseStatus==='ready'});parsed.addEventListener('change',()=>{data.parseStatus=parsed.checked?'ready':'unparsed';dirty();});panel.append(el('label',{className:'kn-checkbox'},parsed,'我已添加并核对正文，可将这些文字用于检索'));}
  }else{
   if(data.author)panel.append(el('p',{className:'muted'},data.author));
   if(data.url&&/^https?:\/\//i.test(data.url))panel.append(el('p',{},el('a',{href:data.url,target:'_blank',rel:'noopener noreferrer'},'打开原始链接 ↗')));
  }
  for(const attachmentId of data.attachmentIds||[]){
   const wrapper=el('div',{className:'kn-attachment'},el('a',{href:'/api/attachments/'+encodeURIComponent(attachmentId),target:'_blank',rel:'noopener noreferrer'},'查看原附件 ↗'));
   const info=data.attachments?.find(a=>a.id===attachmentId);if(info){wrapper.firstChild.textContent=`${info.name} ↗`;if(info.mime?.startsWith('image/'))wrapper.append(el('img',{src:'/api/attachments/'+encodeURIComponent(attachmentId),alt:info.name,loading:'lazy'}));}panel.append(wrapper);
  }
 }
 async function importFile(file){
  if(!file)return;const status=detail.querySelector('.kn-save-status');if(status)status.textContent='正在保存原文件…';
  try{
   const data=state.data,attachment=await ctx.api.upload(file);
   if(state.data!==data||state.disposed){ctx.notify('文件已上传，当前编辑内容已经改变；请回到原材料重新选择文件。');return;}
   data.attachmentIds??=[];data.attachmentIds.push(attachment.id);data.attachments??=[];data.attachments.push(attachment);
   if(!data.title)data.title=file.name;
   if(/\.(txt|md|markdown)$/i.test(file.name)||['text/plain','text/markdown'].includes(file.type)){
    data.body=await file.text();data.format=/\.(md|markdown)$/i.test(file.name)?'markdown':'text';data.parseStatus='ready';
   }else{data.format='attachment';data.parseStatus='unparsed';}
   dirty();renderDetail();ctx.notify('文件已保留。保存材料后可在目录中找到。');
  }catch(e){tell(e);if(status)status.textContent='导入未完成；可以重试。';}
 }

 function renderReferenceBlocks(panel,readonly){
  const data=state.data;const blocks=(data.blocks||[]).filter(b=>b.kind==='reference');
  if(blocks.length){panel.append(el('h3',{className:'kn-section-title'},'编入文稿的内容'));const refs=el('div',{className:'kn-citations'});panel.append(refs);blocks.forEach((block,i)=>{
   const wrap=el('section',{className:'kn-reference-block'});refs.append(wrap);renderCitation(wrap,block.ref,!readonly?()=>{data.blocks=data.blocks.filter(b=>b.id!==block.id);dirty();renderDetail();}:null,!readonly?newRef=>{block.ref=newRef;dirty();renderDetail();}:null,true);
   if(!readonly){const controls=el('div',{className:'row'});if(i>0)controls.append(button('上移',()=>moveBlock(block.id,-1),'button ghost'));if(i<blocks.length-1)controls.append(button('下移',()=>moveBlock(block.id,1),'button ghost'));wrap.append(controls);}
  });}
  if(!readonly)panel.append(button('编入已有记录或知识项',()=>pickReference(ref=>{data.blocks??=[];data.blocks.push({id:id('block'),kind:'reference',ref});dirty();renderDetail();}),'button'));
 }
 function moveBlock(blockId,delta){const blocks=state.data.blocks.filter(b=>b.kind==='reference');const index=blocks.findIndex(b=>b.id===blockId);[blocks[index],blocks[index+delta]]=[blocks[index+delta],blocks[index]];state.data.blocks=[...state.data.blocks.filter(b=>b.kind!=='reference'),...blocks];dirty();renderDetail();}

 async function renderCitation(parent,ref,onRemove,onUpdate,full=false){
  const card=el('article',{className:'kn-citation'},el('p',{className:'small muted'},'正在读取引用…'));parent.append(card);
  try{
   const options={includeDeleted:true,...(ref.versionMode==='pinned'?{revision:ref.revision}:{})};
   const [snapshot,latest]=await Promise.all([ctx.api.get(ref.targetId,options),ctx.api.get(ref.targetId,{includeDeleted:true})]);
   if(state.disposed||!card.isConnected)return;
   const status=referenceStatus(ref,snapshot,latest);const label=ref.versionMode==='pinned'?`固定版本 ${ref.revision}`:'跟随当前版本';
   card.replaceChildren(el('div',{className:'row'},button(titleOf(snapshot),()=>goObject(ref),'kn-text-link'),el('span',{className:'badge'},label)));
   if(!status.valid)card.append(el('p',{className:'error'},status.message));
   else if(full)card.append(renderMarkdown(status.text||''));
   else if(ref.quote)card.append(el('blockquote',{},ref.quote));
   else card.append(el('p',{className:'kn-citation-preview'},(status.text||'').slice(0,180)||'仅保留材料位置。'));
   if(status.deleted){card.append(el('p',{className:'error'},'原内容已删除；此处保留原引用。'),button('查看并恢复原内容',()=>goObject({...ref,versionMode:'live',revision:null}),'button ghost'));}
   if(status.newer){card.append(el('p',{className:'kn-update-notice'},`原内容已有版本 ${status.currentRevision}，此处继续使用版本 ${ref.revision}。`),button('查看版本差异',()=>showDifference(snapshot,latest,ref,onUpdate),'button ghost'));}
   if(onRemove)card.append(button('移除引用',onRemove,'button ghost small'));
  }catch(e){if(card.isConnected){card.replaceChildren(el('p',{className:'error'},'引用暂时无法定位：'+errorText(e)),button('重试',()=>{card.remove();renderCitation(parent,ref,onRemove,onUpdate,full);},'button ghost'));if(onRemove)card.append(button('移除引用',onRemove,'button ghost'));}}
 }

 async function renderConnections(panel,readonly){
  panel.append(el('p',{className:'muted small'},'关系有明确方向；支持、质疑与前提均由你主动建立。'));
  if(!state.object){panel.append(el('p',{},'先保存内容，即可建立关系并查看反向引用。'));return;}
  if(!readonly)panel.append(button('建立关联',()=>relationDialog(),'button'));
  const results=el('div',{className:'kn-connections'},el('p',{className:'muted'},'正在查找关联…'));panel.append(results);
  const selected=state.object;
  try{
   const objects=await allContent();if(state.disposed||!results.isConnected)return;
   const map=new Map(objects.map(o=>[o.id,o]));
   const relationships=objects.filter(o=>o.objectType==='relation'&&(o.data.from.targetId===selected.id||o.data.to.targetId===selected.id));
   const incoming=incomingRefs(selected.id,objects).filter(r=>r.object.objectType!=='relation');
   results.replaceChildren(el('h3',{},'有方向的关联'));
   if(!relationships.length)results.append(el('p',{className:'muted'},'尚未建立关联。'));
   const reverse={supports:'受到支持',refutes:'受到质疑',defines:'定义来自',premiseOf:'前提包含',exampleOf:'例子包含',relatedTo:'相关'};
   for(const relation of relationships){const data=relation.data,outgoing=data.from.targetId===selected.id,other=outgoing?data.to:data.from,otherObj=map.get(other.targetId);const card=el('article',{className:'kn-connection'},el('div',{className:'row'},el('span',{className:'badge'},outgoing?RELATION_TYPES[data.kind]:reverse[data.kind]),button(otherObj?titleOf(otherObj):'查看关联内容',()=>goObject(other),'kn-text-link')),data.explanation?el('p',{},data.explanation):null);if(!readonly)card.append(button('移除关联',async()=>{try{await ctx.api.remove(relation);renderDetail();}catch(e){tell(e);}},'button ghost small'));results.append(card);}
   results.append(el('h3',{className:'kn-section-title'},`被哪些内容引用 · ${incoming.length}`));
   if(!incoming.length)results.append(el('p',{className:'muted'},'还没有其他内容引用它。'));
   for(const item of incoming)results.append(el('div',{className:'kn-connection'},el('span',{className:'badge'},item.role),button(titleOf(item.object),()=>goObject(refOf(item.object,'live')),'kn-text-link'),el('span',{className:'small muted'},item.ref.versionMode==='pinned'?`引用版本 ${item.ref.revision}`:'跟随当前版本')));
  }catch(e){results.replaceChildren(el('p',{className:'error'},errorText(e)),button('重试',()=>renderDetail()));}
 }

 async function allContent(){
  const [metadata,documents]=await Promise.all([
   ctx.api.list({objectTypes:['entry','knowledge','source','relation','citation','message','discussion','predictionReview'],limit:100000,summary:true}),
   ctx.api.list({objectType:'document',limit:100000})
  ]);
  return [...metadata.items,...documents.items];
 }
 async function renderHistory(panel){
  panel.append(el('p',{className:'muted small'},'每次保存保留一个版本。固定引用继续指向当时选定的版本。'));
  const host=el('div',{className:'kn-history'},'正在读取版本…');panel.append(host);
  try{const history=await ctx.api.history(state.object.id);if(!host.isConnected)return;host.replaceChildren(...history.map(o=>el('div',{className:'kn-history-item'},el('div',{},el('strong',{},`版本 ${o.revision}${o.deletedAt?' · 已删除':''}`),el('p',{className:'muted small'},formatDate(o.updatedAt))),el('div',{className:'row'},button('阅读',()=>{keepObjectDraft();open(o.id,o.revision);},'button ghost'),button('与当前比较',async()=>{try{const latest=await ctx.api.get(o.id,{includeDeleted:true});showDifference(o,latest);}catch(e){tell(e);}},'button ghost')))));}
  catch(e){host.replaceChildren(el('p',{className:'error'},errorText(e)),button('重试',()=>renderDetail()));}
 }

 function dialog(title){
  const modal=el('dialog',{className:'kn-dialog','aria-label':title});const body=el('div',{className:'kn-dialog-body'});const close=()=>{modal.close();modal.remove();};modal.append(el('div',{className:'kn-dialog-heading'},el('h2',{},title),button('关闭',close,'button ghost')),body);container.append(modal);modal.addEventListener('close',()=>modal.remove());modal.addEventListener('click',e=>{if(e.target===modal)close();});modal.showModal();return {modal,body,close};
 }
 function showDelete(){const dlg=dialog('移入回收站');dlg.body.append(el('p',{},'此内容将从普通目录隐藏，已有引用和所有历史版本仍会保留。之后可以恢复。'),button('移入回收站',async()=>{try{await ctx.api.remove(state.object);dlg.close();await open(state.object.id);await loadList();}catch(e){tell(e);}},'button danger'));}
 function showDifference(previous,current,ref,onUpdate){
  const dlg=dialog('查看版本差异');const diff=versionDifference(previous,current);
  dlg.body.append(el('p',{className:'muted'},`版本 ${previous.revision} → 版本 ${current.revision}`));
  if(!diff.changed)dlg.body.append(el('p',{},'正文没有变化；其他字段或删除状态可能已更新。'));
  else dlg.body.append(el('div',{className:'kn-diff-grid'},el('section',{},el('h3',{},'旧版本中的文字'),el('pre',{className:'kn-diff removed'},diff.removed||'（无）')),el('section',{},el('h3',{},'新版本中的文字'),el('pre',{className:'kn-diff added'},diff.added||'（无）'))));
  dlg.body.append(el('details',{},el('summary',{},'阅读两个版本全文'),el('h3',{},`版本 ${previous.revision}`),renderMarkdown(previous.data.body),el('h3',{},`版本 ${current.revision}`),renderMarkdown(current.data.body)));
  if(ref&&onUpdate&&!current.deletedAt){
   const candidate={...copy(ref),revision:current.revision};const valid=validateCitation(candidate,current);
   if(valid.valid)dlg.body.append(button('主动更新此引用',()=>{onUpdate(candidate);dlg.close();ctx.notify('引用已改为新版本；保存后生效。');},'button primary'));
   else dlg.body.append(el('p',{className:'error'},'新版本中的原位置或原文已变化。请重新选择片段后再引用。'));
  }
 }
 function showConflict(){
  const dlg=dialog('保留两边的修改');dlg.body.append(el('p',{},'另一处已经保存了更新。你的正文仍在编辑区，不会覆盖它。可以复制自己的内容，或先比较最新版本。'));
  dlg.body.append(button('查看最新版本与我的正文',async()=>{try{const latest=await ctx.api.get(state.object.id,{includeDeleted:true});dlg.body.append(el('h3',{},'最新已保存版本'),renderMarkdown(latest.data.body),el('h3',{},'我尚未保存的内容'),renderMarkdown(state.data.body),button('以最新版本为基础继续合并',()=>{state.object=latest;state.historical=false;state.requestId=null;dirty();dlg.close();renderDetail();ctx.notify('已更新保存基准；编辑区仍保留你的内容，请合并后保存。');},'button'));}catch(e){tell(e);}},'button'));
 }

 async function pickReference(onPick,{title='选择引用材料',allowLive=true}={}){
  const dlg=dialog(title),query=el('input',{type:'search',placeholder:'按标题或正文搜索','aria-label':'搜索引用目标'}),results=el('div',{className:'kn-picker-list'}),preview=el('div',{className:'kn-picker-preview'});
  dlg.body.append(query,results,preview);let timer,token=0,chooseToken=0;
  async function searchTargets(){const t=++token;results.replaceChildren(el('p',{className:'muted'},'正在查找…'));try{const result=await ctx.api.list({objectTypes:['entry','knowledge','document','source','message'],q:query.value,limit:30,summary:true});if(t!==token||!results.isConnected)return;const items=result.items.filter(o=>o.objectType!=='message'||o.data.status==='complete');results.replaceChildren(...items.map(o=>button(`${typeName(o)||'消息'} · ${titleOf(o)}`,()=>choose(o),'kn-picker-item')));if(!items.length)results.append(el('p',{className:'muted'},'没有匹配内容。'));if(result.total>30)results.append(el('p',{className:'small muted'},'显示前 30 项；输入更具体的文字缩小范围。'));}catch(e){results.replaceChildren(el('p',{className:'error'},errorText(e)));}}
  async function choose(summary){
   const selected=++chooseToken;preview.replaceChildren(el('p',{className:'muted'},'正在读取原文…'));
   let object;try{object=await ctx.api.get(summary.id);}catch(e){preview.replaceChildren(el('p',{className:'error'},errorText(e)));return;}
   if(selected!==chooseToken||!preview.isConnected)return;
   const body=object.data.body||'',ref=refOf(object);if(object.objectType==='message')ref.locator={discussionId:object.data.discussionId};
   const versions=el('select',{'aria-label':'引用版本方式'},el('option',{value:'pinned'},`固定版本 ${object.revision}（证据推荐）`),allowLive?el('option',{value:'live'},'跟随当前版本'):null);
   const text=el('textarea',{readonly:true,rows:7,value:body,'aria-label':'原文，可选中一个片段'});const quote=el('p',{className:'kn-quote-choice muted'},'将引用整份内容。也可以在原文中选中片段。');
   const status=el('p',{className:'error',role:'status'});
   text.addEventListener('select',()=>{if(text.selectionEnd>text.selectionStart){ref.quote=body.slice(text.selectionStart,text.selectionEnd);ref.locator={...(object.objectType==='message'?{discussionId:object.data.discussionId}:{}),start:text.selectionStart,end:text.selectionEnd};quote.textContent='选中片段：'+ref.quote;}else{ref.quote=null;ref.locator=object.objectType==='message'?{discussionId:object.data.discussionId}:null;quote.textContent='将引用整份内容。';}});
   preview.replaceChildren(el('h3',{},titleOf(object)),versions,text,quote,status,button('加入引用',()=>{
    ref.versionMode=versions.value;ref.revision=ref.versionMode==='pinned'?object.revision:null;
    const check=validateCitation(ref,object);if(!check.valid){status.textContent=check.message;return;}onPick(copy(ref),object);dlg.close();
   },'button primary'));
  }
  query.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(searchTargets,180);});await searchTargets();query.focus();
 }

 async function relationDialog(){
  if(state.dirty){ctx.notify('先保存正文，再建立关联。');return;}
  const current=state.object;const dlg=dialog('建立有方向的关联');const direction=el('select',{'aria-label':'关系方向'},el('option',{value:'incoming'},'另一份内容 → 当前内容'),el('option',{value:'outgoing'},'当前内容 → 另一份内容'));
  const kind=el('select',{'aria-label':'关系类型'},...Object.entries(RELATION_TYPES).map(([value,label])=>el('option',{value},label)));
  const selected=el('p',{className:'muted'},'尚未选择另一份内容。'),explanation=el('textarea',{rows:3,placeholder:'为什么建立这个联系？（可选）','aria-label':'关系说明'}),error=el('p',{className:'error',role:'status'});let other=null;
  dlg.body.append(field('方向',direction),field('关系',kind),selected,button('选择另一份内容',()=>pickReference((ref,obj)=>{other={ref,object:obj};selected.textContent=titleOf(obj);},{title:'选择关系另一端',allowLive:false})),field('你的说明',explanation),error,button('建立关联',async()=>{
   if(!other){error.textContent='请先选择另一份内容。';return;}
   try{const from=direction.value==='incoming'?other.object:current,to=direction.value==='incoming'?current:other.object,fromRef=direction.value==='incoming'?other.ref:refOf(current),toRef=direction.value==='incoming'?refOf(current):other.ref;const existing=await ctx.api.list({objectType:'relation',limit:100000});const change=prepareRelationChange({kind:kind.value,from:fromRef,to:toRef,explanation:explanation.value},from,to,existing.items);await ctx.api.commit([change]);dlg.close();renderDetail();ctx.notify('已建立关联');}catch(e){error.textContent=errorText(e);}
  },'button primary'));
 }

 if(ctx.params?.viewState){state.query=ctx.params.viewState.query||'';state.filter=ctx.params.viewState.filter||'all';search.value=state.query;filter.value=state.filter;}
 await loadList();
 if(ctx.params?.objectId)await open(ctx.params.objectId,ctx.params.revision);
 else if(ctx.params?.seedRefs?.length)await startNew('claim',ctx.params.seedRefs);
 else if(remembered){Object.assign(state,{object:remembered.object,data:remembered.data,type:remembered.type,editing:remembered.editing,dirty:remembered.dirty,historical:remembered.historical,tab:remembered.tab,draftKey:remembered.draftKey,draftObject:remembered.draftObject,draftId:remembered.draftId,lastDraftPayload:remembered.lastDraftPayload});renderDetail();detail.scrollTop=remembered.scroll||0;renderList();}
 else if(state.savedDrafts?.length)await resumeDraft(state.savedDrafts[0]);
 else if(lastSelected.has(mode))await open(lastSelected.get(mode));
 else renderDetail();
 if(ctx.params?.viewState){state.tab=ctx.params.viewState.tab||'body';renderDetail();detail.scrollTop=ctx.params.viewState.scroll||0;}
 return {getNavigationState(){const objectId=state.dirty&&state.draftObject?state.draftObject.id:state.object?.id;return{...(objectId?{objectId}:{}),...(state.historical?{revision:state.object?.revision}:{}),viewState:{query:state.query,filter:state.filter,tab:state.tab,scroll:detail.scrollTop}};},async dispose(){if(state.saveDone)await state.saveDone;await flushDraft();keepObjectDraft();saveMemory();state.disposed=true;clearTimeout(queryTimer);clearTimeout(draftTimer);window.removeEventListener('beforeunload',onBeforeUnload);container.removeEventListener('keydown',onKeyboard);container.querySelectorAll('dialog').forEach(d=>d.close());},refresh:()=>loadList(),open:(objectId,revision)=>open(objectId,revision),newEntry:()=>startNew(sources?'text':'document')};
}
