import {el,button,field,emptyState} from '../../packages/ui/index.js';
import DOMPurify from '../../packages/ui/vendor/dompurify/dist/purify.es.mjs';
import {id} from '../../packages/contracts/index.js';
import {MARKS,GLYPHS,cpLength,quoteTarget,blockText} from './model.js';
import {captureSelection,selectionRects,copyTargets,svgMark,regionTarget} from './selection.js';
import {codexConfig,companionPrompt} from './companion.js';
import {transformRegion,regionControls} from './region-edit.js';
import {metadataEditor} from './metadata-ui.js';
import {libraryRoom,categoryOf} from './room.js';
import {rememberedPage,pageNavigator} from './reading-state.js';
import {wheelPager,bindReaderWheel} from './wheel.js';
import {outlineView} from './outline-ui.js';
import {nativeAnnotationRects} from './native-anchors.js';

const NS='http://www.w3.org/2000/svg';
const svg=()=>{const n=document.createElementNS(NS,'svg');n.classList.add('lib-overlay');n.setAttribute('aria-hidden','true');return n;};
let pdfModule;
async function pdfjs(){if(!pdfModule){pdfModule=await import('/packages/ui/vendor/pdfjs/pdf.mjs');pdfModule.GlobalWorkerOptions.workerSrc='/packages/ui/vendor/pdfjs/pdf.worker.mjs';}return pdfModule;}
const colors=['#e1b34e','#c9684c','#51866a','#6694b5','#aa77a6'];

export async function mount(container,ctx){
 if(!document.querySelector('link[data-library-immersive]'))document.head.append(el('link',{rel:'stylesheet',href:'/features/library/immersive.css','data-library-immersive':true}));
 if(ctx.params?.section==='convert')return(await import('./conversion-view.js')).mount(container,ctx);
 const state={pub:null,outline:null,blocks:[],annotations:[],pageIndex:0,view:'reflow',fontSize:18,targets:[],activeAnnotation:null,disposed:false,readingToken:0,busy:false,shelf:'',query:'',undo:[],redo:[],sessionId:id('reader'),command:null};
 let pdf=null,jobTimer,sessionTimer,queryTimer,pendingNote='',drawMode=false,capabilities=null,restoredDraft=null,stopRegion=null,autosaveTimer=null,savingPromise=null,draftEpoch=0,gestureFrame=null,gestureActive=false;
 state.dirty=false;
 const call=(name,args={})=>ctx.api.library(name,args);
 // Keep an uncertain write's request id, including across refresh, until a receipt arrives.
 async function write(name,args){
  if(name.startsWith('reader_'))return call(name,{...args,requestId:id('request')});
  const key='library-pending-writes',pending=JSON.parse(sessionStorage.getItem(key)||'[]'),fingerprint=JSON.stringify({name,args});
  let item=pending.find(p=>p.fingerprint===fingerprint);if(!item){item={fingerprint,requestId:id('request')};pending.push(item);sessionStorage.setItem(key,JSON.stringify(pending));}
  try{const result=await call(name,{...args,requestId:item.requestId});sessionStorage.setItem(key,JSON.stringify(JSON.parse(sessionStorage.getItem(key)||'[]').filter(p=>p.requestId!==item.requestId)));return result;}
  catch(e){if(e.code&&e.code!=='SERVICE_UNAVAILABLE')sessionStorage.setItem(key,JSON.stringify(JSON.parse(sessionStorage.getItem(key)||'[]').filter(p=>p.requestId!==item.requestId)));throw e;}
 }
 const fail=e=>ctx.notify(e.message,'error');
 const draftKey=()=>state.pub&&state.outline?'library-annotation-draft:'+state.pub.id+':'+state.outline.renditionId:null;
 function keepDraft(){const key=draftKey();if(!key||!noteInput)return;pendingNote=noteInput.value;sessionStorage.setItem(key,JSON.stringify({pageIndex:state.pageIndex,view:state.view,dirty:state.dirty,pendingWrite:state.pendingWrite,targets:state.targets,body:pendingNote,mark:{type:markSelect.value,color:colorSelect.value},activeAnnotation:state.activeAnnotation,editRevision:state.editRevision}));sessionStorage.setItem('library-note-'+state.pub.id,pendingNote);}
 function currentMark(){return{type:markSelect?.value||'highlight',color:colorSelect?.value||'#d29d36',opacity:.3};}
 function selectionStatus(){if(!toolbarStatus)return;toolbarStatus.textContent=state.targets.length?(state.activeAnnotation?'已选批注':'新批注')+' · '+MARKS[currentMark().type]+(state.targets.every(t=>t.kind==='region')?' · 拖动移动，拖角点缩放':' · 文字位置随原文固定'):drawMode?'单击放置，或拖动绘制；完成后自动保存。':'选择文字后点符号；已有标记可直接拖动。';}
 function saveFeedback(message){if(saveStatus)saveStatus.textContent=message;}
 function markDirty(delay=550){state.dirty=true;draftEpoch++;keepDraft();saveFeedback(state.targets.length?'正在编辑 · 稍后自动保存':'先选中原文或放置标记');clearTimeout(autosaveTimer);if(state.targets.length&&!gestureActive)autosaveTimer=setTimeout(()=>saveAnnotation({automatic:true}).catch(fail),delay);updateSaveButtons();}
 function updateSaveButtons(){if(saveButton)saveButton.disabled=noteSaveButton.disabled=state.busy||!state.targets.length||!!state.pub?.deletedAt||(!state.dirty&&!!state.activeAnnotation);}
 async function flushDraft(){clearTimeout(autosaveTimer);if(savingPromise)await savingPromise;if(state.dirty&&state.targets.length)await saveAnnotation({automatic:true});}
 function setDrawMode(value){drawMode=value;regionButton?.setAttribute('aria-pressed',String(value));moveButton?.setAttribute('aria-pressed',String(!value));original?.classList.toggle('lib-drawing',value);selectionStatus();}
 async function clearSelection(){await flushDraft();state.activeAnnotation=null;state.dirty=false;pendingNote='';if(noteInput)noteInput.value='';setTargets([]);renderAnnotations();}
 function loadAnnotation(an){state.activeAnnotation=an.id;state.editRevision=an.revision;state.dirty=false;noteInput.value=an.data.body;markSelect.value=an.data.mark.type;colorSelect.value=an.data.mark.color;setTargets(structuredClone(an.data.targets));renderAnnotations();sync();}
 async function selectAnnotation(an){await flushDraft();loadAnnotation(an);}
 const root=el('div',{className:'lib-root',tabIndex:-1});container.replaceChildren(root);
 let room=null,stage=null,progress=null,pageInput=null,pageTotal=null,pageStatus=null,notesButton=null,tocButton=null,settingsButton=null,pageTurn=0,pdfLoading=null,zoom='fit',zoomScale=1,zoomLabel=null,directory=null,unbindWheel=null;
 const wheelGate=wheelPager();
 const blockCache=new Map(),imageCache=new Map();
 const positionKey=()=>state.pub&&state.outline?'library-position:'+state.pub.id+':'+state.outline.renditionId:null;
 function remember(){const key=positionKey();if(key)try{localStorage.setItem(key,JSON.stringify({pageIndex:state.pageIndex,view:state.view}));}catch{}keepDraft();}
 function immersive(mode){document.body.classList.add('library-space');root.dataset.mode=mode;}
 function panel(name){const key=name+'Open';state[key]=!state[key];root.classList.toggle('lib-'+name+'-open',state[key]);({notes:notesButton,toc:tocButton,settings:settingsButton}[name])?.setAttribute('aria-expanded',String(state[key]));requestAnimationFrame(fitOriginal);}
 async function act(name,args){const r=await write(name,args);if(!['book_correct'].includes(name)){state.undo.push({id:r.operationId,revision:r.operationRevision});state.redo=[];}return r;}
 function modal(title){const dialog=el('dialog',{className:'lib-dialog','aria-label':title}),body=el('div',{className:'lib-dialog-body'});dialog.append(el('header',{},el('h2',{},title),button('关闭',()=>dialog.close(),'button ghost')),body);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();return{dialog,body};}
 function downloadJson(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/ld+json'}));const a=el('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function importDialog(){
  const{dialog,body}=modal('加入藏书'),file=el('input',{type:'file',accept:'.book.zip','aria-label':'已转换阅读包'}),message=el('p',{role:'status',className:'muted'});
  const add=button('加入已转换阅读包',async()=>{if(!file.files.length){message.textContent='请先选择 .book.zip 阅读包。';return;}add.disabled=true;try{const asset=await ctx.api.upload(file.files[0]),result=await write('library_import',{attachmentId:asset.id,shelf:state.shelf||'未分类'});dialog.close();await openBook(result.publicationId);}catch(e){message.textContent=e.message;add.disabled=false;}},'button primary');
  body.append(el('p',{},'PDF、扫描件、EPUB 和文字先在格式转换中处理。检查结果后，再加入藏书。'),button('先去格式转换',()=>{dialog.close();ctx.navigate('library',{section:'convert'});},'button primary'),field('已有转换文件',file),message,add);
 }
 async function importSource(){const{body,dialog}=modal('从已有材料建立藏书');const list=await ctx.api.list({objectType:'source',limit:200,summary:true});for(const s of list.items)body.append(button(s.data.title||'未命名材料',async()=>{try{const result=await write('conversion_start',{sourceId:s.id});dialog.close();await ctx.navigate('library',{section:'convert',objectId:result.jobId});}catch(e){fail(e);}},'lib-source-choice'));}
 async function shelf(){
  await flushDraft();stopRegion?.();unbindWheel?.();unbindWheel=null;
  room?.dispose();room=null;immersive('shelf');root.classList.remove('lib-notes-open','lib-toc-open','lib-settings-open');
  state.pub=null;state.readingToken++;history.replaceState(null,'','#library');await sync();if(pdf){await pdf.destroy();pdf=null;}
  const header=el('div',{className:'lib-welcome'},el('div',{},el('span',{className:'lib-eyebrow'},'MY PRIVATE LIBRARY'),el('h2',{},'材料藏书'),el('p',{},'走进书页，暂别喧嚣。')),el('div',{className:'row'},button('← 回到工作空间',()=>ctx.navigate('chronicle'),'button ghost'),button('格式转换',()=>ctx.navigate('library',{section:'convert'}),'button ghost'),button('＋ 加入藏书',importDialog,'button primary')));
  const search=el('input',{type:'search',value:state.query,placeholder:'搜索书名、作者…','aria-label':'搜索藏书'}),shelves=el('select',{'aria-label':'选择书架'},el('option',{value:''},'所有书架')),trash=el('input',{type:'checkbox','aria-label':'显示已删除藏书'}),grid=el('div',{className:'lib-books'}),status=el('p',{className:'muted small'});
  const sceneHost=el('div',{className:'lib-room-host'});let listView=false;
  const switcher=button('列表浏览',()=>{listView=!listView;sceneHost.hidden=listView;grid.hidden=!listView;switcher.textContent=listView?'进入图书馆':'列表浏览';},'button ghost');grid.hidden=true;
  root.replaceChildren(header,el('div',{className:'lib-shelf-tools'},search,shelves,switcher,el('label',{},trash,'含回收站'),button('从已有材料收录',importSource,'button ghost'),button('Agent 接口',()=>agentDialog().catch(fail),'button ghost'),status),sceneHost,grid);
  let generation=0;async function load(){const token=++generation;try{const r=await call('library_list',{query:state.query,includeDeleted:trash.checked,limit:200});if(token!==generation||state.pub||state.disposed)return;status.textContent=`${r.total} 本藏书${r.nextOffset?' · 当前显示前 200 本，请搜索缩小范围':''}`;const choices=new Set(r.items.map(categoryOf));for(const v of choices)if(![...shelves.options].some(o=>o.value===v))shelves.append(el('option',{value:v},v));shelves.value=state.shelf;r.items=r.items.filter(p=>!state.shelf||categoryOf(p)===state.shelf);room?.dispose();room=libraryRoom(r.items,{open:openBook,onError:fail});sceneHost.replaceChildren(room.root);
   grid.replaceChildren(...r.items.map((p,i)=>{const book=button('',()=>openBook(p.id).catch(fail),'lib-book');book.style.setProperty('--book-color',['#38594a','#996850','#637b8c','#847b57','#745e70'][i%5]);book.append(el('div',{className:'lib-book-cover'},el('span',{className:'lib-book-series'},p.data.shelf||'藏书'),el('strong',{},p.data.title),el('span',{className:'lib-book-author'},p.data.author||'等待一次阅读'),el('span',{className:'lib-book-rule'})),el('div',{className:'lib-book-info'},el('strong',{},p.data.title),el('span',{},p.deletedAt?'已删除':p.data.currentRendition?`${p.data.coverage?.totalPages||0} 页 · 可阅读`:'原件已保留 · 待转换')));return book;}));
   if(!r.items.length)grid.append(emptyState('你的第一排藏书','先转换 PDF、扫描书或 EPUB，检查结果后再加入藏书。',button('先转换一本书',()=>ctx.navigate('library',{section:'convert'}),'button primary')));
  }catch(e){sceneHost.replaceChildren(emptyState('藏书暂时没有打开',e.message,button('重新加载',()=>load())));fail(e);}}
  search.addEventListener('input',()=>{state.query=search.value;clearTimeout(queryTimer);queryTimer=setTimeout(load,200);});shelves.addEventListener('change',()=>{state.shelf=shelves.value;load();});trash.addEventListener('change',load);await load();
 }
 async function agentDialog(){
  await sync();const {body}=modal('Agent 接口'),response=await fetch('/api/library/connection');if(!response.ok)throw new Error('连接配置读取失败');const connection=await response.json(),config=connection.mcpServers['chronicle-library'];
  const copy=async(value,label)=>{try{await navigator.clipboard.writeText(value);ctx.notify(label+'已复制');}catch{ctx.notify('请在下方文本中手动复制。');}};
  body.append(el('div',{className:'lib-agent-context'},state.pub?`《${state.pub.data.title}》 · 第 ${state.pageIndex+1} 页 · ${state.targets.length?'已选中内容':'当前整页'} · 窗口 ${state.sessionId}`:'打开一本书后，可复制当前阅读位置给 Agent。'),el('ol',{className:'lib-agent-steps'},el('li',{},'保持岁月史书运行，在 Codex 或支持本机 MCP 的 Agent 设置中添加 STDIO 服务。'),el('li',{},'名称填 chronicle-library，使用下面的命令和参数，保存后重新连接 MCP。'),el('li',{},'在外部 Agent 中直接说出阅读、翻页或编辑要求；首次让它调用 library_agent_guide。无需在本应用中聊天。')));
  body.append(el('p',{className:'small muted'},'连接配置不含模型密钥。这里提供阅读接口；回答由你连接的 Agent 生成。'),el('pre',{},'命令：'+config.command+'\n参数：'+config.args.join('\n')+'\n环境变量：CHRONICLE_URL='+config.env.CHRONICLE_URL));
  if(state.pub){const prompt=el('textarea',{rows:7,readOnly:true,'aria-label':'伴读指令',value:companionPrompt(state.sessionId)});body.append(button('复制伴读指令',()=>copy(prompt.value,'伴读指令'),'button primary'),prompt);}
  const codex=codexConfig(connection);body.append(el('details',{},el('summary',{},'Codex 配置'),el('p',{},'在 Codex 设置 → MCP servers 添加 STDIO 服务；也可将下列配置合并到 config.toml，避免重复同名配置。'),button('复制 Codex 配置',()=>copy(codex,'Codex 配置'),'button ghost'),el('pre',{},codex)),el('details',{},el('summary',{},'其他 MCP 客户端配置'),button('复制 MCP JSON',()=>copy(JSON.stringify(connection,null,2),'MCP 配置'),'button ghost'),el('pre',{},JSON.stringify(connection,null,2))),el('p',{},'豆包普通网页/桌面客户端需要自身提供自定义 MCP 入口才能直接调用；当前未确认其支持。纯云端不能直接访问本机地址。'),el('a',{href:'/api/library/agent-guide',target:'_blank',rel:'noopener'},'Agent 使用说明'),el('a',{href:'/api/library/schema',target:'_blank',rel:'noopener'},'接口与 Function Tools'),el('a',{href:'/api/library/openapi.json',target:'_blank',rel:'noopener'},'OpenAPI 3.1 描述'));
 }
 async function openBook(publicationId,renditionId){
  await flushDraft();stopRegion?.();state.dirty=false;state.pendingWrite=null;
  room?.dispose();room=null;pdfLoading=null;blockCache.clear();imageCache.clear();
  const previousBook=state.pub?.id,token=++state.readingToken;state.targets=[];state.activeAnnotation=null;state.pageIndex=0;state.pub=await ctx.api.get(publicationId,{includeDeleted:true});if(token!==state.readingToken||state.disposed)return;if(previousBook!==publicationId)state.view=/\.(pdf|png|jpe?g|webp|tiff?)$/i.test(state.pub.data.originalName||'')?'original':'reflow';
  if(pdf){await pdf.destroy();pdf=null;}
  try{state.outline=await call('book_outline',{publicationId,...(renditionId?{renditionId}:{})});}catch(e){if(e.code!=='RENDITION_UNAVAILABLE')throw e;state.outline=null;}
  if(state.outline)state.pageIndex=rememberedPage(localStorage,positionKey(),state.outline.pages.length);
  history.replaceState(null,'','#library?id='+encodeURIComponent(publicationId)+(renditionId?'&rendition='+encodeURIComponent(renditionId):''));pendingNote=sessionStorage.getItem('library-note-'+publicationId)||'';restoredDraft=null;try{const saved=JSON.parse(sessionStorage.getItem(draftKey())||'null');if(saved&&Number.isInteger(saved.pageIndex)&&state.outline?.pages[saved.pageIndex]&&Array.isArray(saved.targets)){restoredDraft=saved;state.pendingWrite=saved.pendingWrite;state.dirty=!!saved.pendingWrite||(saved.dirty??true);if(["original","reflow","compare"].includes(saved.view))state.view=saved.view;state.pageIndex=saved.pageIndex;state.targets=saved.targets;state.activeAnnotation=saved.activeAnnotation||null;state.editRevision=saved.editRevision;pendingNote=saved.body||'';}}catch{}renderReader();try{await renderPage();setTargets(state.targets,{persist:false});if(restoredDraft?.targets.length&&state.dirty)saveFeedback('已恢复未保存的草稿；继续编辑或点击保存。');await sync();root.focus({preventScroll:true});}catch(e){pageStatus.textContent='这一页加载失败，请点击重试';fail(e);}
 }
 let article,original,notes,toolbarStatus,noteInput,pageLabel,outlineList,annotationList,versionSelect,viewSelect,markSelect,colorSelect,layout,saveButton,noteSaveButton,saveStatus,jobStatus,regionButton,moveButton,markPalette;
 function renderReader(){
  const p=state.pub;unbindWheel?.();root.replaceChildren();immersive('reader');state.notesOpen=!!(restoredDraft?.targets.length&&state.dirty);state.tocOpen=true;state.settingsOpen=false;root.classList.toggle('lib-notes-open',state.notesOpen);root.classList.add('lib-toc-open');root.classList.remove('lib-settings-open');wheelGate.reset();
  const top=el('div',{className:'lib-reader-top'},button('‹ 返回书架',()=>shelf().catch(fail),'button ghost'),el('div',{className:'lib-reader-title'},el('h2',{},p.data.title),el('span',{className:'muted small'},p.data.author||'材料藏书')),button('书目与导出',bookMenu,'button ghost'));
  if(p.deletedAt)top.append(button('恢复藏书',async()=>{await write('library_restore',{id:p.id,expectedRevision:p.revision});await openBook(p.id);},'button primary'));
  versionSelect=el('select',{'aria-label':'内容版本'},...(p.data.renditions||[]).map((r,i)=>el('option',{value:r.id},`内容版本 ${i+1}${r.id===p.data.currentRendition?' · 当前':''}`)));versionSelect.value=state.outline?.renditionId||'';versionSelect.addEventListener('change',()=>openBook(p.id,versionSelect.value).catch(fail));
  viewSelect=el('select',{'aria-label':'阅读视图'},el('option',{value:'reflow'},'重排阅读'),el('option',{value:'original'},'原版页面'),el('option',{value:'compare'},'并排校对'));viewSelect.value=state.view;viewSelect.onchange=()=>{state.view=viewSelect.value;keepDraft();applyView();renderOriginal().catch(fail);sync();};
  const font=el('input',{type:'range',min:14,max:32,value:state.fontSize,'aria-label':'阅读字号'});font.oninput=()=>{state.fontSize=Number(font.value);fitOriginal();redraw();sync();};
  tocButton=button('目录',()=>panel('toc'),'button ghost');notesButton=button('笔记',()=>panel('notes'),'button ghost');settingsButton=button('阅读设置',()=>panel('settings'),'button ghost');for(const [b,name]of [[tocButton,'toc'],[notesButton,'notes'],[settingsButton,'settings']]){b.setAttribute('aria-expanded',String(!!state[name+'Open']));b.setAttribute('aria-controls','lib-'+name+'-'+state.sessionId);}top.append(tocButton,notesButton,settingsButton,button('Agent 接口',()=>agentDialog().catch(fail),'button ghost'));
  const fit=el('select',{'aria-label':'页面大小'},el('option',{value:'fit'},'整页适应'),el('option',{value:'width'},'适应宽度'));fit.value=zoom;fit.onchange=()=>{zoom=fit.value;zoomScale=1;fitOriginal();};
  const fullscreen=button('全屏',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await root.requestFullscreen();}catch{ctx.notify('当前窗口不支持全屏；已使用沉浸阅读布局。');}},'button ghost');
  root.append(top,el('div',{className:'lib-reading-controls',id:'lib-settings-'+state.sessionId},versionSelect,viewSelect,field('字号',font),fit,fullscreen));
  markSelect=el('select',{'aria-label':'标记类型'},...Object.entries(MARKS).map(([value,label])=>el('option',{value},(GLYPHS[value]||'')+' '+label)));colorSelect=el('input',{type:'color',value:'#d29d36','aria-label':'标记颜色'});
  if(restoredDraft?.mark){if(MARKS[restoredDraft.mark.type])markSelect.value=restoredDraft.mark.type;colorSelect.value=restoredDraft.mark.color;}
  markPalette=el('div',{className:'lib-mark-palette',role:'group','aria-label':'标记工具'});
  for(const [type,label]of Object.entries(MARKS)){const icon=svg();icon.setAttribute('viewBox','0 0 32 28');svgMark(icon,{type,color:'#526a59'},[{x:5,y:5,width:22,height:18}],{placement:'region'});const tool=button('',()=>{markSelect.value=type;chooseMark().catch(fail);},'lib-mark-tool');tool.setAttribute('aria-label',label);tool.title=label;tool.dataset.markType=type;tool.append(icon);markPalette.append(tool);}
  async function chooseMark(){if(state.busy)await savingPromise;redraw();selectionStatus();if(state.targets.length)markDirty(180);else{setDrawMode(true);if(state.view==='reflow'){state.view='original';viewSelect.value=state.view;applyView();await renderOriginal();}}keepDraft();}
  markSelect.onchange=()=>chooseMark().catch(fail);colorSelect.oninput=()=>{redraw();if(state.targets.length)markDirty(250);else keepDraft();};
  moveButton=button('选择 / 移动',()=>{stopRegion?.();setDrawMode(false);},'button ghost');
  regionButton=button('新标记',async()=>{try{await clearSelection();setDrawMode(true);if(state.view==='reflow'){state.view='original';viewSelect.value=state.view;applyView();await renderOriginal();}}catch(e){fail(e);}},'button ghost');
  saveButton=button('保存标记',()=>saveAnnotation().catch(fail),'button primary');saveButton.disabled=true;
  toolbarStatus=el('span',{className:'lib-selection-status',role:'status'},'选中文字、点选公式，或框选原页');
  const toolbar=el('div',{className:'lib-mark-toolbar'},moveButton,regionButton,markPalette,markSelect,colorSelect,saveButton,button('撤销',()=>undo(false).catch(fail),'button ghost'),button('重做',()=>undo(true).catch(fail),'button ghost'),toolbarStatus);
  toolbar.addEventListener('pointerdown',e=>{if(e.target.closest('button'))e.preventDefault();});markSelect.classList.add('lib-mark-select');setDrawMode(false);
  outlineList=el('nav',{className:'lib-outline','aria-label':'书内目录'});const search=el('input',{type:'search',placeholder:'查找原文…','aria-label':'搜索书内原文'});const results=el('div',{className:'lib-search-results'});search.addEventListener('input',()=>{clearTimeout(queryTimer);queryTimer=setTimeout(async()=>{if(!search.value.trim()){results.replaceChildren();return;}try{const r=await call('book_search',{...bookArgs(),query:search.value,limit:40});results.replaceChildren(...r.items.map(item=>button(item.text.slice(0,90),async()=>{await navigatePage(item.pageIndex);setTargets([item.target]);},'lib-outline-link')));}catch(e){fail(e);}},250);});
  directory=outlineView(state.outline,(index,blockId)=>navigatePage(index,blockId).catch(fail));outlineList=directory.root;
  article=el('article',{className:'lib-article','aria-label':'书籍正文',style:{fontSize:state.fontSize+'px'}});original=el('div',{className:'lib-original','aria-label':'原版页面'});
  original.addEventListener('pointerdown',e=>startRegion(e).catch(fail));article.addEventListener('mouseup',capture);article.addEventListener('keyup',capture);article.addEventListener('copy',e=>{if(state.targets.length){e.clipboardData.setData('text/plain',copyTargets(state.blocks,state.targets));e.preventDefault();}});
  noteInput=el('textarea',{rows:4,'aria-label':'批注内容',placeholder:'写下这一处的想法…',value:pendingNote});noteInput.oninput=()=>markDirty();annotationList=el('div',{className:'lib-annotations'});
  noteSaveButton=button('保存批注',()=>saveAnnotation().catch(fail),'button primary');noteSaveButton.disabled=true;saveStatus=el('p',{className:'small muted',role:'status','aria-label':'批注保存状态'},'先选择批注位置，再保存。');
  notes=el('aside',{className:'lib-notes',id:'lib-notes-'+state.sessionId,'aria-label':'阅读笔记'},el('div',{className:'row'},el('h3',{},'页边的思考'),button('收起笔记',()=>panel('notes'),'button ghost')),toolbar,noteInput,noteSaveButton,saveStatus,el('div',{className:'row'},button('复制选中内容',async()=>{try{await navigator.clipboard.writeText(copyTargets(state.blocks,state.targets));ctx.notify('已复制原文与公式');}catch(e){fail(e);}},'button ghost'),button('取消选中',()=>clearSelection().catch(fail),'button ghost')),annotationList);
  const pages=el('div',{className:'lib-pages'},article,original);stage=el('div',{className:'lib-reading-stage',tabIndex:-1},pages);
  const left=el('aside',{className:'lib-left-rail','aria-label':'目录与查找'},el('section',{className:'lib-toc',id:'lib-toc-'+state.sessionId},el('div',{className:'row'},el('h3',{},'目录与查找'),button('收起目录',()=>panel('toc'),'button ghost')),search,results,outlineList));
  layout=el('div',{className:'lib-reader-layout'},left,stage,notes);root.append(layout);
  unbindWheel=bindReaderWheel({root,stage,pager:wheelGate,isReader:()=>!!state.pub,isBlocked:()=>gestureActive||!!window.getSelection()?.toString()||turnPages.busy,getScale:()=>zoomScale,onZoom:changeZoom,onTurn:direction=>turnPages.step(direction).catch(fail)});
  for(const [delta,label,glyph]of [[-1,'上一页','‹'],[1,'下一页','›']]){let start=null,swiped=false;const edge=button(glyph,()=>{if(swiped){swiped=false;return;}turnPages.step(delta).catch(fail);},'lib-page-edge '+(delta<0?'lib-edge-left':'lib-edge-right'));edge.setAttribute('aria-label',label);edge.addEventListener('pointerdown',e=>{swiped=false;if(e.pointerType!=='mouse'){start={x:e.clientX,y:e.clientY};edge.setPointerCapture(e.pointerId);}});edge.addEventListener('pointerup',e=>{if(start&&Math.abs(e.clientX-start.x)>45&&Math.abs(e.clientY-start.y)<45){swiped=true;turnPages.step(e.clientX<start.x?1:-1).catch(fail);}start=null;});edge.addEventListener('pointercancel',()=>start=null);layout.append(edge);}
  pageLabel=el('span',{className:'lib-page-label',role:'status','aria-label':'当前页码'});pageInput=el('input',{type:'number',min:1,max:state.outline?.pages.length||1,value:state.pageIndex+1,'aria-label':'跳转页码'});pageInput.addEventListener('change',()=>navigatePage(Number(pageInput.value)-1).catch(fail));pageInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();navigatePage(Number(pageInput.value)-1).catch(fail);root.focus();}});
  progress=el('input',{type:'range',min:1,max:state.outline?.pages.length||1,value:state.pageIndex+1,'aria-label':'阅读进度'});progress.onchange=()=>navigatePage(Number(progress.value)-1).catch(fail);pageTotal=el('span',{className:'lib-progress-percent'});
  pageStatus=el('span',{className:'lib-load-status',role:'status'});const retry=button('重试',()=>renderPage().catch(fail),'button ghost');
  zoomLabel=button('100%',()=>changeZoom(1),'button ghost lib-zoom-reset');zoomLabel.setAttribute('aria-label','重置书页缩放');zoomLabel.title='Ctrl＋滚轮缩放，点击恢复';
  const smaller=button('−',()=>changeZoom(zoomScale/1.1),'button ghost'),larger=button('＋',()=>changeZoom(zoomScale*1.1),'button ghost');smaller.setAttribute('aria-label','缩小书页');larger.setAttribute('aria-label','放大书页');
  root.append(el('footer',{className:'lib-reader-footer'},el('span',{className:'lib-reader-shortcuts'},'滚轮翻页 · Ctrl＋滚轮缩放'),pageLabel,pageInput,progress,pageTotal,el('div',{className:'lib-zoom-controls'},smaller,zoomLabel,larger),pageStatus,retry));
  jobStatus=el('div',{className:'lib-job-status',role:'status'});root.querySelector('.lib-reading-controls').append(el('details',{},el('summary',{},'转换信息'),jobStatus));applyView();
 }
 function bookArgs(){return{publicationId:state.pub.id,renditionId:state.outline.renditionId};}
  function applyView(){if(layout)layout.dataset.view=state.view;requestAnimationFrame(()=>{fitOriginal();redraw();});}
  const turnPages=pageNavigator({current:()=>state.pageIndex,count:()=>state.outline?.pages.length||0,turn:async(index,blockId)=>{const previous=state.pageIndex;stopRegion?.();await clearSelection();if(state.disposed||!state.pub)return;state.pageIndex=index;pageTurn=Math.sign(index-previous);try{await renderPage();remember();stage.scrollTop=0;if(blockId)article.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)?.scrollIntoView({block:'center'});await sync();}catch(e){state.pageIndex=previous;pageStatus.textContent='翻页失败，可重试';throw e;}}});
  function navigatePage(index,blockId){if(!Number.isInteger(index)||index<0||index>=(state.outline?.pages.length||0)){if(pageInput)pageInput.value=state.pageIndex+1;return Promise.resolve(false);}return turnPages.go(index,blockId);}
  async function readBlocks(args){const key=JSON.stringify(args);if(!blockCache.has(key)){const reading=(async()=>{const blocks=[];let offset=0;do{const r=await call('book_read',{...args,offset,limit:200});blocks.push(...r.items);offset=r.nextOffset;}while(offset!==null);return blocks;})();blockCache.set(key,reading);reading.catch(()=>blockCache.delete(key));if(blockCache.size>6)blockCache.delete(blockCache.keys().next().value);}return blockCache.get(key);}
  function pageImage(page){if(!page.imageAttachmentId)return null;const key=page.imageAttachmentId;if(!imageCache.has(key)){const img=new Image();img.src='/api/attachments/'+key;const ready=img.decode().then(()=>img);imageCache.set(key,ready);ready.catch(()=>imageCache.delete(key));if(imageCache.size>4)imageCache.delete(imageCache.keys().next().value);}return imageCache.get(key);}
 async function renderPage(){
  const token=++state.readingToken;
  if(!state.outline){article.replaceChildren(emptyState('原件已入库','阅读内容正在准备。转换进度和问题会显示在下方。'));if(state.pub.data.originalAttachmentId)original.replaceChildren(el('a',{href:'/api/attachments/'+state.pub.data.originalAttachmentId},'下载原件'));await refreshJob();return;}
   const args={...bookArgs(),pageIndex:state.pageIndex};pageStatus.textContent='正在翻页…';layout.setAttribute('aria-busy','true');
   let blocks,annotations;try{[blocks,annotations]=await Promise.all([readBlocks(args),(async()=>{const items=[];let offset=0;do{const r=await call('annotation_list',{...args,offset,limit:200});items.push(...r.items);offset=r.nextOffset;}while(offset!==null);return items;})(),state.view!=='reflow'?pageImage(state.outline.pages[state.pageIndex]):null]);}catch(e){pageStatus.textContent='加载失败，可重试';throw e;}finally{if(token===state.readingToken)layout.removeAttribute('aria-busy');}
   if(token!==state.readingToken||state.disposed)return;state.blocks=blocks;state.annotations=annotations;
  article.replaceChildren(...blocks.map(renderBlock));if(!blocks.length)article.append(el('p',{className:'muted'},'这一页尚无可用文字。请查看原页，使用框选批注或重试增强识别。'));
  pageLabel.textContent=`${state.outline.pages[state.pageIndex]?.label||state.pageIndex+1} / ${state.outline.pages.length}`;
   pageInput.value=progress.value=state.pageIndex+1;pageTotal.textContent=Math.round((state.pageIndex+1)/state.outline.pages.length*100)+'%';for(const edge of layout.querySelectorAll('.lib-page-edge'))edge.disabled=edge.classList.contains('lib-edge-left')?state.pageIndex===0:state.pageIndex===state.outline.pages.length-1;
   renderAnnotations();if(state.view!=='reflow')await renderOriginal();fitOriginal();updateDirectory();pageStatus.textContent='';remember();if(pageTurn&&!matchMedia('(prefers-reduced-motion: reduce)').matches){stage.querySelector('.lib-pages').animate([{opacity:.65,transform:`translateX(${pageTurn*20}px) rotateY(${pageTurn*3}deg)`},{opacity:1,transform:'none'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});}pageTurn=0;refreshJob().catch(()=>{});requestAnimationFrame(redraw);
   for(const next of [state.pageIndex+1,state.pageIndex-1])if(state.outline.pages[next]){readBlocks({...bookArgs(),pageIndex:next}).catch(()=>{});pageImage(state.outline.pages[next])?.catch(()=>{});}
 }
 function renderBlock(b){
  const wrapper=el('section',{className:'lib-block lib-kind-'+b.kind,dataset:{blockId:b.id}}),content=el(b.kind==='heading'?'h3':b.kind==='code'?'pre':'div',{className:'lib-block-content',dataset:{blockContent:b.id}});let position=0;
  for(const r of b.runs){const start=position;position+=r.atom?1:cpLength(r.text);const span=el('span',{className:r.atom?'lib-atom':'lib-run',dataset:{runStart:start,runEnd:position,...(r.atom?{atom:r.atom}:{})},style:{...(r.bold?{fontWeight:'bold'}:{}),...(r.italic?{fontStyle:'italic'}:{})}});
   if(r.atom==='formula'){
    try{if(r.latex){if(!globalThis.katex)throw new Error('公式组件加载中');globalThis.katex.render(r.latex,span,{displayMode:b.kind==='formula',throwOnError:true,trust:false,strict:'ignore'});}else span.innerHTML=DOMPurify.sanitize(r.mathml,{USE_PROFILES:{mathMl:true},FORBID_TAGS:['annotation-xml'],FORBID_ATTR:['href','src','style']});}
    catch{if(b.imageAttachmentId)span.append(el('img',{src:'/api/attachments/'+b.imageAttachmentId,alt:'公式原图'}));else span.append(el('code',{},r.latex||'[公式无法显示]'));}
   }else if(r.atom==='image'){const asset=r.attachmentId||b.imageAttachmentId;if(asset){const img=el('img',{alt:r.alt||'原书图片',loading:'lazy'});span.append(img);if(r.mime==='image/svg+xml')fetch('/api/attachments/'+asset).then(r=>r.text()).then(value=>{const clean=DOMPurify.sanitize(value,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject','a','image','use','style'],FORBID_ATTR:['href','xlink:href','style']});img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(clean);}).catch(()=>{img.alt='图片加载失败';});else img.src='/api/attachments/'+asset;}else span.textContent=r.alt||'请查看原页图片';}
   else span.textContent=r.text;
   if(r.atom){const end=position;span.setAttribute('tabindex','0');span.setAttribute('role','button');span.setAttribute('aria-label','选择'+(r.atom==='formula'?'公式':'图片'));const select=async()=>{try{await clearSelection();setTargets([['formula','figure'].includes(b.kind)?{kind:'object',blockId:b.id}:quoteTarget(b,start,end)]);sync();}catch(e){fail(e);}};span.onclick=select;span.onkeydown=e=>{if(e.key==='Enter')select();};}
   content.append(span);
  }
  const tools=el('div',{className:'lib-block-tools'},button('校对',()=>correctBlock(b),'button ghost'));tools.setAttribute('aria-label','校对此段');
  wrapper.append(content,svg(),tools);return wrapper;
 }
 async function capture(){if(gestureActive)return;const targets=captureSelection(article,state.blocks);if(targets.length){try{await clearSelection();setTargets(targets);sync();}catch(e){fail(e);}}}
  function setTargets(targets,{persist=true}={}){state.targets=targets;if(!state.activeAnnotation)state.editRevision=null;if(targets.length&&persist&&!state.notesOpen)panel('notes');updateSaveButtons();selectionStatus();saveFeedback(state.dirty?'待保存':state.activeAnnotation?'已保存 · 修改后自动保存':targets.length?'选择符号或输入笔记，自动保存':'选中原文或放置标记后，笔记自动保存');updateDirectory();redraw();if(persist)keepDraft();}
  function updateDirectory(){directory?.update(state.pageIndex);}
 function redraw(){
  if(!article||state.disposed)return;for(const tool of markPalette?.children||[])tool.setAttribute('aria-pressed',String(tool.dataset.markType===markSelect.value));
  for(const wrapper of article.querySelectorAll('[data-block-id]')){const content=wrapper.querySelector('[data-block-content]'),overlay=wrapper.querySelector('svg.lib-overlay'),base=wrapper.getBoundingClientRect();overlay.replaceChildren();overlay.setAttribute('viewBox',`0 0 ${base.width} ${base.height}`);
   const paint=(t,mark,selected)=>{if(t.blockId!==wrapper.dataset.blockId)return;const rs=t.kind==='object'?[content.getBoundingClientRect()]:selectionRects(content,t);svgMark(overlay,mark,rs.map(r=>({x:r.x-base.x,y:r.y-base.y,width:r.width,height:r.height})),{selected});};
   for(const an of state.annotations)if(an.id!==state.activeAnnotation)for(const t of an.data.targets)paint(t,an.data.mark,false);
   for(const t of state.targets)paint(t,currentMark(),true);
  }
  redrawRegions();
 }
 function renderAnnotations(){annotationList.replaceChildren(el('h4',{},`本页批注 · ${state.annotations.length}`));for(const an of state.annotations){const card=el('article',{className:'lib-note'+(an.id===state.activeAnnotation?' active':'')});const quote=an.data.targets.map(t=>t.exact||(t.kind==='region'?'原页区域':'公式 / 图片')).join(' … ');card.append(button(MARKS[an.data.mark.type]+' · '+quote.slice(0,80),()=>selectAnnotation(an).catch(fail),'lib-note-quote'),el('p',{},an.data.body||'仅标记'),button('删除',()=>deleteAnnotation(an).catch(fail),'button ghost'));annotationList.append(card);}}
 async function deleteAnnotation(an){await flushDraft();const latest=state.annotations.find(a=>a.id===an.id)||an;await act('annotation_delete',{id:an.id,expectedRevision:latest.revision});state.annotations=state.annotations.filter(a=>a.id!==an.id);if(state.activeAnnotation===an.id){state.dirty=false;state.activeAnnotation=null;noteInput.value='';setTargets([]);}renderAnnotations();redraw();saveFeedback('已删除 · 可撤销');}
 async function saveAnnotation({automatic=false}={}){
  clearTimeout(autosaveTimer);if(savingPromise){await savingPromise;if(state.dirty)return saveAnnotation({automatic});return;}
  if(!state.targets.length)return;if(!state.dirty&&state.activeAnnotation&&!state.pendingWrite)return;
  const context={...bookArgs(),pageIndex:state.pageIndex},key=draftKey(),epoch=draftEpoch,targets=structuredClone(state.targets),body=noteInput.value,mark=currentMark();let active=state.activeAnnotation,an=state.annotations.find(o=>o.id===active),expectedRevision=state.editRevision??an?.revision;
  const same=()=>!state.disposed&&state.pub?.id===context.publicationId&&state.outline?.renditionId===context.renditionId&&state.pageIndex===context.pageIndex&&state.activeAnnotation===active;
  state.busy=true;updateSaveButtons();saveFeedback('正在保存…');keepDraft();
  savingPromise=(async()=>{try{
   let replay=null;
   // An unacknowledged create must be replayed before applying newer text, including after reload.
   if(state.pendingWrite){const pending=state.pendingWrite,receipt=await act(pending.name,pending.args);active=receipt.annotationId;expectedRevision=receipt.objects.find(o=>o.id===active).revision;an={...(an||{}),id:active,revision:expectedRevision,data:{...(an?.data||{}),...pending.args,targets:pending.args.targets||an?.data.targets||targets}};state.activeAnnotation=active;state.editRevision=expectedRevision;state.pendingWrite=null;state.annotations=state.annotations.filter(o=>o.id!==active);state.annotations.push(an);keepDraft();if((pending.args.body||'')===body&&JSON.stringify(pending.args.mark)===JSON.stringify(mark)&&JSON.stringify(pending.args.targets||targets)===JSON.stringify(targets))replay=receipt;}
   if(active&&!an)throw new Error('原批注已不在当前页，请刷新核对后再保存。');
   const operation=an?'annotation_update':'annotation_create',args=an?{id:an.id,expectedRevision,body,mark,...(targets.every(t=>t.kind==='region')?{targets}:{})}:{publicationId:context.publicationId,renditionId:context.renditionId,targets,body,mark};
   if(!replay){state.pendingWrite={name:operation,args};keepDraft();}const result=replay||await act(operation,args);state.pendingWrite=null;
   const annotation={...(an||{}),id:result.annotationId,objectType:'annotation',revision:result.objects.find(o=>o.id===result.annotationId).revision,data:{...(an?.data||{publicationId:context.publicationId,renditionId:context.renditionId,author:'本机读者'}),targets,body,mark}};
   if(same()){state.annotations=state.annotations.filter(o=>o.id!==annotation.id);state.annotations.push(annotation);state.activeAnnotation=annotation.id;state.editRevision=annotation.revision;state.dirty=draftEpoch!==epoch;keepDraft();renderAnnotations();redraw();selectionStatus();saveFeedback(state.dirty?'新改动等待保存':'已自动保存到本机');sync();}else sessionStorage.removeItem(key);
   if(!automatic)ctx.notify('批注已保存');
  }catch(e){if(same()){if(e.code&&e.code!=='SERVICE_UNAVAILABLE')state.pendingWrite=null;state.dirty=true;keepDraft();saveFeedback('保存失败：'+e.message+' 草稿已保留，点击保存重试。');}throw e;
  }finally{state.busy=false;savingPromise=null;updateSaveButtons();}})();
  await savingPromise;if(state.dirty&&draftEpoch!==epoch&&!gestureActive)autosaveTimer=setTimeout(()=>saveAnnotation({automatic:true}).catch(fail),250);
 }
 async function undo(redo){await flushDraft();const stack=redo?state.redo:state.undo,item=stack.at(-1);if(!item){ctx.notify(redo?'没有可重做操作':'没有可撤销操作');return;}const result=await write(redo?'operation_redo':'operation_undo',{id:item.id,expectedRevision:item.revision});stack.pop();(redo?state.undo:state.redo).push({id:item.id,revision:result.targetOperationRevision});state.dirty=false;state.activeAnnotation=null;noteInput.value='';setTargets([]);await renderPage();saveFeedback(redo?'已重做':'已撤销');}
 async function correctBlock(b){const{body,dialog}=modal('校对原文');const formula=b.kind==='formula',mixed=b.runs.some(r=>r.atom)&&!formula;const value=el('textarea',{rows:8,value:formula?b.latex||b.runs[0]?.latex||'':b.text,readonly:mixed,'aria-label':'校对文字'}),status=el('select',{},el('option',{value:'corrected'},'已校正'),el('option',{value:'verified'},'已核对'),el('option',{value:'needs-review'},'仍需校对'));body.append(el('p',{},'保存生成新的内容版本，已有批注保留在原版本。含行内公式的混排段落可核对状态；公式原图可在原版视图查看。'),value,status,button('保存校对版本',async()=>{try{const p=await ctx.api.get(state.pub.id);await write('book_correct',{id:p.id,expectedRevision:p.revision,corrections:[{blockId:b.id,...(mixed?{}:formula?{latex:value.value}:{text:value.value}),reviewStatus:status.value}]});dialog.close();await openBook(p.id);}catch(e){fail(e);}},'button primary'));}
  function fitOriginal(){
   if(!stage||!state.outline)return;const page=state.outline.pages[state.pageIndex],pages=stage.querySelector('.lib-pages'),css=getComputedStyle(stage),available=Math.max(120,stage.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight)),column=state.view==='compare'?Math.max(100,(available-20)/2):available;
   const paperWidth=Math.min(column,zoom==='fit'?Math.max(160,stage.clientHeight-46)*(page.width/page.height):1000)*zoomScale,reflowWidth=Math.min(column,760)*zoomScale;
   article.style.fontSize=state.fontSize*zoomScale+'px';article.style.width=reflowWidth+'px';article.style.maxWidth='none';
   const contentWidth=state.view==='reflow'?reflowWidth:state.view==='compare'?Math.max(paperWidth,reflowWidth)*2+20:paperWidth;pages.style.width=Math.max(available,contentWidth)+'px';pages.style.maxWidth='none';
   if(zoomLabel)zoomLabel.textContent=Math.round(zoomScale*100)+'%';root.dataset.zoom=zoomScale.toFixed(3);
   const surface=original?.querySelector('.lib-original-surface');if(!surface){redraw();return;}surface.style.maxWidth='none';surface.style.width=paperWidth+'px';
   const layer=surface.querySelector('.textLayer');if(layer?.dataset.pageWidth)layer.style.transform='scale('+surface.getBoundingClientRect().width/Number(layer.dataset.pageWidth)+')';
   surface.querySelector('.lib-scan-text')?.remove();renderScanLayer(surface);redrawRegions();
  }
  function changeZoom(value,pointer){
   if(!stage||!state.outline||gestureActive)return;const rect=stage.getBoundingClientRect(),focus=state.view==='reflow'?article:original.querySelector('.lib-original-surface'),before=focus?.getBoundingClientRect();
   const x=pointer&&pointer.x>=rect.left&&pointer.x<=rect.right?pointer.x:rect.left+rect.width/2,y=pointer&&pointer.y>=rect.top&&pointer.y<=rect.bottom?pointer.y:rect.top+rect.height/2;
   const anchor=before?{x:Math.max(0,Math.min(1,(x-before.left)/before.width)),y:Math.max(0,Math.min(1,(y-before.top)/before.height))}:null;
   zoomScale=Math.max(.5,Math.min(3,value));fitOriginal();const after=focus?.getBoundingClientRect();if(anchor&&after){stage.scrollLeft+=after.left+anchor.x*after.width-x;stage.scrollTop+=after.top+anchor.y*after.height-y;}wheelGate.reset();redraw();
  }
  async function renderOriginal(){
   if(!state.outline||state.view==='reflow')return;const key=[state.pub.id,state.outline.renditionId,state.pageIndex].join(':'),existing=original.firstElementChild;if(existing?.dataset.originalKey===key&&existing.dataset.ready==='true'){fitOriginal();if(/\.pdf$/i.test(state.pub.data.originalName||'')&&!existing.querySelector('.textLayer')&&!state.blocks.some(b=>b.recognition.method==='ocr'))loadNativeText(existing,state.pageIndex,state.readingToken).catch(()=>{});return;}
   const token=state.readingToken,pageIndex=state.pageIndex,page=state.outline.pages[pageIndex],surface=el('div',{className:'lib-original-surface',dataset:{originalKey:key}});
   if(page.imageAttachmentId){const cached=await pageImage(page);if(token!==state.readingToken||state.disposed)return;const img=cached.cloneNode();img.alt='原书第 '+page.label+' 页';surface.append(img);}
   else{surface.append(el('p',{className:'muted'},'此材料没有固定原页，请选择重排阅读。'));original.replaceChildren(surface);return;}
   const overlay=svg();overlay.removeAttribute('aria-hidden');surface.append(overlay);surface.dataset.ready='true';original.replaceChildren(surface);original.classList.toggle('lib-drawing',drawMode);fitOriginal();
   // The original image is immediately usable; native text loads independently.
   if(/\.pdf$/i.test(state.pub.data.originalName||'')&&!state.blocks.some(b=>b.recognition.method==='ocr'))loadNativeText(surface,pageIndex,token).catch(()=>{if(surface.isConnected)pageStatus.textContent='原页已显示；文字可切换到重排阅读';});
  }
  async function loadNativeText(surface,pageIndex,token){
   const lib=await pdfjs(),publicationId=state.pub?.id;if(token!==state.readingToken||state.disposed)return;
   if(!pdfLoading)pdfLoading=lib.getDocument({url:'/api/attachments/'+state.pub.data.originalAttachmentId,disableAutoFetch:true,disableStream:true,rangeChunkSize:65536,cMapUrl:'/packages/ui/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/packages/ui/vendor/pdfjs/standard_fonts/',wasmUrl:'/packages/ui/vendor/pdfjs/wasm/',isEvalSupported:false}).promise;
   const doc=await pdfLoading;if(state.disposed||state.pub?.id!==publicationId){await doc.destroy();return;}pdf=doc;
   const p=await doc.getPage(pageIndex+1),content=await p.getTextContent();if(token!==state.readingToken||!surface.isConnected)return;
   const vp=p.getViewport({scale:1}),textLayer=el('div',{className:'textLayer',dataset:{pageWidth:vp.width},style:{width:vp.width+'px',height:vp.height+'px'}});textLayer.style.setProperty('--total-scale-factor','1');textLayer.style.setProperty('--scale-factor','1');surface.append(textLayer);
   await new lib.TextLayer({textContentSource:content,container:textLayer,viewport:vp}).render();if(token!==state.readingToken||!surface.isConnected)return;textLayer.style.width=vp.width+'px';textLayer.style.height=vp.height+'px';fitOriginal();
   textLayer.addEventListener('mouseup',async()=>{if(drawMode||gestureActive)return;try{const selection=window.getSelection(),q=selection?.toString();if(!q?.trim()||!selection.rangeCount)return;const candidates=[];
    for(const b of state.blocks){let at=0;while((at=b.text.indexOf(q,at))>=0){const start=cpLength(b.text.slice(0,at));candidates.push(quoteTarget(b,start,start+cpLength(q)));at+=q.length;}}
    if(candidates.length===1){const bounds=surface.getBoundingClientRect();candidates[0].regions=[...selection.getRangeAt(0).getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>{const x=Math.max(0,(r.x-bounds.x)/bounds.width),y=Math.max(0,(r.y-bounds.y)/bounds.height);return{pageIndex,rect:[x,y,Math.min(r.width/bounds.width,1-x),Math.min(r.height/bounds.height,1-y)]};});await clearSelection();setTargets(candidates);sync();}
    else ctx.notify('此选区不能唯一对应原文，请在重排视图选择，或使用区域批注。');
   }catch(e){fail(e);}});
  }
 function redrawRegions(){const surface=original?.querySelector('.lib-original-surface'),overlay=surface?.querySelector('svg.lib-overlay');if(!overlay)return;const bounds=surface.getBoundingClientRect();overlay.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);overlay.replaceChildren();
  const paint=(t,mark,selected=false)=>{const b=state.blocks.find(b=>b.id===t.blockId),regions=t.kind==='region'?[t]:t.regions||(t.kind==='text'&&b?.textRegions?.length?b.textRegions.filter(r=>r.end>t.start&&r.start<t.end).map(r=>({...r,pageIndex:b.pageIndex})):b?.sourceRegions||[]);let rects=regions.filter(r=>r.pageIndex===state.pageIndex).map(r=>{const[x,y,w,h]=r.rect;return{x:x*bounds.width,y:y*bounds.height,width:w*bounds.width,height:h*bounds.height};});if(t.kind==='text'&&b&&!t.regions?.length&&!b.textRegions?.length){const exact=nativeAnnotationRects(surface.querySelector('.textLayer'),b.text,t,bounds);if(exact.length)rects=exact;}svgMark(overlay,mark,rects,{selected,placement:t.kind==='region'?'region':'text'});};
  for(const a of state.annotations)if(a.id!==state.activeAnnotation)for(const t of a.data.targets)paint(t,a.data.mark);for(const t of state.targets)paint(t,currentMark(),true);
  for(const an of state.annotations)if(an.id!==state.activeAnnotation)an.data.targets.forEach((t,index)=>{if(t.kind==='region'&&t.pageIndex===state.pageIndex)regionControls(overlay,t,bounds,{id:an.id,index,label:MARKS[an.data.mark.type]});});
  state.targets.forEach((t,index)=>{if(t.kind==='region'&&t.pageIndex===state.pageIndex)regionControls(overlay,t,bounds,{id:state.activeAnnotation||'',index,selected:true,label:MARKS[currentMark().type]});});
 }
 function renderScanLayer(surface){
  const scanned=state.blocks.filter(b=>b.recognition.method==='ocr'&&b.textRegions?.length);if(!scanned.length)return;
  // OCR word rectangles are retained. Selection maps to the canonical text;
  // uncertain OCR is never represented as verified character geometry.
  const layer=el('div',{className:'lib-scan-text'});surface.append(layer);const bounds=surface.getBoundingClientRect();
  const canvas=document.createElement('canvas'),measure=canvas.getContext('2d');
  for(const b of scanned){const line=el('div',{dataset:{blockContent:b.id}});layer.append(line);let offset=0;
   for(let i=0;i<b.textRegions.length;i++){const r=b.textRegions[i],end=b.textRegions[i+1]?.start??cpLength(b.text),str=Array.from(b.text).slice(offset,end).join(''),[x,y,w,h]=r.rect,fontSize=h*bounds.height;const span=el('span',{text:str,dataset:{runStart:offset,runEnd:end},style:{left:x*100+'%',top:y*100+'%',fontSize:fontSize+'px'}});measure.font=fontSize+'px Arial';span.style.transform=`scaleX(${w*bounds.width/Math.max(1,measure.measureText(Array.from(b.text).slice(r.start,r.end).join('')).width)})`;line.append(span);offset=end;}
  }
  layer.addEventListener('mouseup',async()=>{if(drawMode||gestureActive)return;const selected=captureSelection(layer,state.blocks);if(selected.length){await clearSelection();setTargets(selected);sync();toolbarStatus.textContent='OCR 选区 · 词框定位，识别内容需校对';}});
 }
 async function startRegion(event){
  if(event.button!==0||gestureActive||state.pub?.deletedAt)return;const surface=event.target.closest('.lib-original-surface');if(!surface?.querySelector('canvas,img'))return;
  const hit=event.target.closest('[data-region-handle]'),annotationId=hit?.dataset.regionId,index=Number(hit?.dataset.regionIndex||0),handle=hit?.dataset.regionHandle;
  if(!hit&&!drawMode){if(state.activeAnnotation)await clearSelection();return;}
  event.preventDefault();await flushDraft();stopRegion?.();
  if(annotationId&&annotationId!==state.activeAnnotation){const an=state.annotations.find(a=>a.id===annotationId);if(!an)return;loadAnnotation(an);}
  const bounds=surface.getBoundingClientRect(),start={x:event.clientX-bounds.x,y:event.clientY-bounds.y},previous=structuredClone(state.targets),previousAnnotation=state.activeAnnotation,previousRevision=state.editRevision,previousBody=noteInput.value;
  if(!hit){state.activeAnnotation=null;state.editRevision=null;noteInput.value='';state.targets=[];}
  const base=hit?structuredClone(state.targets[index]):null;if(hit&&base?.kind!=='region')return;
  gestureActive=true;clearTimeout(autosaveTimer);surface.setPointerCapture(event.pointerId);surface.classList.add('lib-gesturing');let moved=false,last=event;
  const preview=e=>{const end={x:e.clientX-bounds.x,y:e.clientY-bounds.y};moved ||= Math.hypot(end.x-start.x,end.y-start.y)>2;if(base){state.targets[index]=transformRegion(base,handle,end.x-start.x,end.y-start.y,bounds);}else{const target=regionTarget(start,end,bounds,markSelect.value,state.pageIndex,{allowClick:true});state.targets=target?[target]:[];}redrawRegions();};
  const move=e=>{if(e.pointerId!==event.pointerId)return;last=e;if(gestureFrame===null)gestureFrame=requestAnimationFrame(()=>{gestureFrame=null;preview(last);});};
  const cleanup=()=>{if(gestureFrame!==null)cancelAnimationFrame(gestureFrame);gestureFrame=null;surface.removeEventListener('pointermove',move);surface.removeEventListener('pointerup',finish);surface.removeEventListener('pointercancel',cancel);surface.removeEventListener('lostpointercapture',cancel);if(surface.hasPointerCapture(event.pointerId))surface.releasePointerCapture(event.pointerId);surface.classList.remove('lib-gesturing');gestureActive=false;stopRegion=null;};
  const finish=e=>{if(e.pointerId!==event.pointerId)return;preview(e);cleanup();root.focus({preventScroll:true});setDrawMode(false);setTargets(state.targets);if(moved||!base)markDirty(0);sync();};
  const cancel=()=>{cleanup();state.targets=previous;state.activeAnnotation=previousAnnotation;state.editRevision=previousRevision;noteInput.value=previousBody;setTargets(previous);};stopRegion=cancel;
  surface.addEventListener('pointermove',move);surface.addEventListener('pointerup',finish);surface.addEventListener('pointercancel',cancel);surface.addEventListener('lostpointercapture',cancel);
 }
 async function refreshJob(){if(!state.pub||!jobStatus)return;const data=await call('import_status',{publicationId:state.pub.id});state.hasActiveJob=data.items.some(j=>['queued','running'].includes(j.data.status));jobStatus.replaceChildren();for(const j of data.items){const labels={queued:'等待转换',running:'正在转换',complete:'转换完成',partial:'部分页面需处理',failed:'转换未完成',cancelled:'已取消',interrupted:'上次转换已中断'};const row=el('div',{className:'row'},el('span',{},`${labels[j.data.status]||j.data.status} · ${j.data.completedPages||0}${j.data.totalPages?' / '+j.data.totalPages:''} 页`));if(j.data.error)row.append(el('span',{className:'error'},j.data.error));if(['running','queued'].includes(j.data.status))row.append(button('取消',async()=>{await write('import_cancel',{id:j.id,expectedRevision:j.revision});await refreshJob();},'button ghost'));else row.append(button('重新转换',async()=>{await write('import_retry',{id:j.id,expectedRevision:j.revision});await refreshJob();},'button ghost'),button('Docling 增强',async()=>{await write('import_retry',{id:j.id,expectedRevision:j.revision,mode:'docling'});await refreshJob();},'button ghost'));jobStatus.append(row);}
  if(state.outline){const page=state.outline.pages[state.pageIndex];for(const warning of page.warnings||[])jobStatus.append(el('p',{className:'small muted'},warning));}
 }
 async function bookMenu(){const{dialog,body}=modal('书目与导出'),p=await ctx.api.get(state.pub.id,{includeDeleted:true});const edits={},editor=metadataEditor(p.data,{prefix:'修改',onChange:(k,value)=>edits[k]=value}),shelfInput=el('input',{value:p.data.shelf,'aria-label':'移动书架'});body.append(editor.root,field('书架',shelfInput),button('保存书目',async()=>{try{await write('library_update_metadata',{id:p.id,expectedRevision:p.revision,...edits,shelf:shelfInput.value});dialog.close();await openBook(p.id);}catch(e){fail(e);}},'button primary'),button('导出阅读包',async()=>{try{const r=await write('book_export',{publicationId:p.id});el('a',{href:r.url,download:r.name}).click();}catch(e){fail(e);}}),button('导出批注 JSON-LD',async()=>{try{downloadJson(await call('annotation_export',{publicationId:p.id,includeDeleted:true}),p.data.title+'-批注.jsonld');}catch(e){fail(e);}}));
  body.append(button('全部版本批注与回收站',()=>{dialog.close();allAnnotations().catch(fail);}));
  const file=el('input',{type:'file',accept:'.json,.jsonld','aria-label':'导入批注'});file.onchange=async()=>{try{const data=JSON.parse(await file.files[0].text());await write('annotation_import',{publicationId:p.id,annotations:data.items||[data]});dialog.close();await renderPage();}catch(e){fail(e);}};body.append(field('导入本书批注',file),button('移入回收站',async()=>{try{await write('library_remove',{id:p.id,expectedRevision:p.revision});dialog.close();await shelf();}catch(e){fail(e);}},'button ghost danger'));
 }
 async function allAnnotations(){
  const{body,dialog}=modal('全部版本批注与回收站'),publicationId=state.pub.id;let offset=0;
  const more=button('加载更多',()=>load().catch(fail));body.append(more);
  async function load(){const r=await call('annotation_list',{publicationId,includeDeleted:true,offset,limit:100});for(const a of r.items){const card=el('article',{className:'lib-note'},el('p',{},a.data.body||'仅标记'),el('small',{},(a.deletedAt?'已删除 · ':'')+(a.data.renditionId===state.pub.data.currentRendition?'当前版本':'历史版本')),el('blockquote',{},a.data.targets.map(t=>t.exact||'公式 / 图片 / 原页区域').join(' … ')));
   card.append(button('定位原文',async()=>{try{const context=await call('annotation_read_context',{id:a.id});dialog.close();await openBook(publicationId,a.data.renditionId);const first=context.context[0];await navigatePage(first.target.pageIndex??first.block?.pageIndex??0);state.activeAnnotation=a.id;state.editRevision=a.revision;noteInput.value=a.data.body;markSelect.value=a.data.mark.type;colorSelect.value=a.data.mark.color;setTargets(a.data.targets);renderAnnotations();}catch(e){fail(e);}},'button ghost'));
   if(a.deletedAt)card.append(button('恢复批注',async()=>{try{await act('annotation_restore',{id:a.id,expectedRevision:a.revision});dialog.close();await renderPage();}catch(e){fail(e);}},'button ghost'));
   else if(a.data.renditionId!==state.pub.data.currentRendition)card.append(button('预览迁移到当前版本',async()=>{try{const result=await call('annotation_reanchor_preview',{id:a.id,renditionId:state.pub.data.currentRendition}),preview=modal('核对迁移目标');preview.body.append(el('p',{},'只有唯一对应的文字可以在此迁移。迁移前请核对下方原文。'));for(const s of result.segments)preview.body.append(el('blockquote',{},s.candidates.length===1?s.candidates[0].prefix+'【'+s.candidates[0].exact+'】'+s.candidates[0].suffix:'对应不唯一或无法定位，请在新版本重新选择。'));if(result.segments.every(s=>s.status==='exact'))preview.body.append(button('确认应用迁移',async()=>{try{await act('annotation_reanchor_apply',{id:a.id,expectedRevision:a.revision,renditionId:result.to,targets:result.segments.map(s=>s.candidates[0])});preview.dialog.close();dialog.close();await openBook(publicationId);}catch(e){fail(e);}},'button primary'));}catch(e){fail(e);}},'button ghost'));
   body.insertBefore(card,more);
  }offset=r.nextOffset;more.hidden=offset===null;if(!r.total)body.append(el('p',{},'还没有批注。'));}await load();
 }
 async function sync(){const ack=state.command?{ackCommand:state.command,...(state.commandError?{commandError:state.commandError}:{})}:{};if(!state.pub||!state.outline){try{await write('reader_sync',{sessionId:state.sessionId,closedBook:!state.pub,...ack});}catch{}return;}try{await write('reader_sync',{sessionId:state.sessionId,...bookArgs(),pageIndex:state.pageIndex,view:state.view,fontSize:state.fontSize,targets:state.targets,...ack});}catch{}}
 let sessionPolling=false;
 sessionTimer=setInterval(async()=>{if(state.disposed||sessionPolling)return;sessionPolling=true;try{const remote=await call('reader_get_state',{sessionId:state.sessionId});if(remote?.command&&remote.command!==state.command){try{if(remote.publicationId!==state.pub?.id||remote.renditionId!==state.outline?.renditionId)await openBook(remote.publicationId,remote.renditionId);state.view=remote.view||state.view;state.fontSize=remote.fontSize||state.fontSize;viewSelect.value=state.view;article.style.fontSize=state.fontSize+'px';applyView();if(remote.pageIndex!==state.pageIndex)await navigatePage(remote.pageIndex);else if(state.view!=='reflow')await renderOriginal();if(remote.targets){await clearSelection();setTargets(remote.targets);}state.commandError=null;}catch(e){state.commandError=String(e.message).slice(0,1000);fail(e);}state.command=remote.command;}await sync();}catch{}finally{sessionPolling=false;}},3000);
 jobTimer=setInterval(async()=>{if(!state.pub||state.disposed||state.outline&&!state.hasActiveJob||document.hidden)return;try{const p=await ctx.api.get(state.pub.id,{includeDeleted:true});if(p.data.currentRendition&&!state.outline){await openBook(p.id);return;}await refreshJob();}catch{}},2500);
 const resize=new ResizeObserver(()=>requestAnimationFrame(()=>{fitOriginal();redraw();}));resize.observe(root);
 const keys=e=>{if(!state.pub||e.isComposing||['TEXTAREA','INPUT','SELECT'].includes(e.target.tagName)||e.target.isContentEditable)return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey).catch(fail);return;}
  if(e.key==='Enter'&&e.target.dataset.regionId){e.preventDefault();const an=state.annotations.find(a=>a.id===e.target.dataset.regionId);if(an)selectAnnotation(an).catch(fail);return;}
  if(e.key==='Escape'){e.preventDefault();if(stopRegion)stopRegion();else if(state.targets.length){clearSelection().catch(fail);setDrawMode(false);}else for(const name of ['notes','toc','settings'])if(state[name+'Open'])panel(name);return;}
  if(['Delete','Backspace'].includes(e.key)&&state.activeAnnotation){e.preventDefault();deleteAnnotation(state.annotations.find(a=>a.id===state.activeAnnotation)).catch(fail);return;}
  if(e.key.startsWith('Arrow')&&state.targets.length&&state.targets.every(t=>t.kind==='region')){e.preventDefault();const bounds=original.querySelector('.lib-original-surface')?.getBoundingClientRect();if(!bounds)return;const amount=e.shiftKey?10:1;state.targets=state.targets.map(t=>transformRegion(t,'move',e.key==='ArrowLeft'?-amount:e.key==='ArrowRight'?amount:0,e.key==='ArrowUp'?-amount:e.key==='ArrowDown'?amount:0,bounds));redrawRegions();root.focus({preventScroll:true});markDirty(350);return;}
  if(e.ctrlKey||e.metaKey||e.altKey||e.target.closest('button,a')&&e.key===' ')return;
  if(['ArrowLeft','ArrowRight','PageUp','PageDown',' '].includes(e.key)&&!window.getSelection()?.toString()){e.preventDefault();turnPages.step(e.key==='ArrowLeft'||e.key==='PageUp'||e.key===' '&&e.shiftKey?-1:1).catch(fail);}
 };root.addEventListener('keydown',keys);
 await sync();try{if(ctx.params?.objectId){const o=await ctx.api.get(ctx.params.objectId,{includeDeleted:true});await openBook(o.objectType==='annotation'?o.data.publicationId:o.id,o.objectType==='annotation'?o.data.renditionId:ctx.params.renditionId);}else await shelf();}catch(e){root.replaceChildren(emptyState('藏书暂时没有打开',e.message,el('div',{className:'row'},button('重新打开',()=>location.reload()),button('回到书架',()=>shelf().catch(fail)))));}
 async function refresh(options={}){
  if(!state.pub)return shelf();if(!options.external||!state.outline)return renderPage();
  const publicationId=state.pub.id,renditionId=state.outline.renditionId,pageIndex=state.pageIndex;
  if(options.events?.some(e=>e.objectType==='publication'&&e.objectId===publicationId)){const p=await ctx.api.get(publicationId,{includeDeleted:true});if(state.pub?.id!==publicationId)return;state.pub=p;versionSelect.replaceChildren(...p.data.renditions.map((r,i)=>el('option',{value:r.id},`内容版本 ${i+1}${r.id===p.data.currentRendition?' · 当前':''}`)));versionSelect.value=renditionId;setTargets(state.targets);}
  if(!options.events?.some(e=>e.objectType==='annotation'))return;const items=[];let offset=0;do{const r=await call('annotation_list',{publicationId,renditionId,pageIndex,offset,limit:200});items.push(...r.items);offset=r.nextOffset;}while(offset!==null);
  if(state.pub?.id!==publicationId||state.outline?.renditionId!==renditionId||state.pageIndex!==pageIndex)return;state.annotations=items;renderAnnotations();redraw();
 }
 return{async dispose(){stopRegion?.();unbindWheel?.();room?.dispose();await flushDraft();clearTimeout(autosaveTimer);state.disposed=true;state.readingToken++;document.body.classList.remove('library-space');clearInterval(jobTimer);clearInterval(sessionTimer);clearTimeout(queryTimer);resize.disconnect();if(pdf)await pdf.destroy();},getNavigationState(){return state.pub?{objectId:state.pub.id,renditionId:state.outline?.renditionId}:{};},refresh,open:openBook};
}
