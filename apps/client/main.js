import {api,request} from './api.js';
import {el,button,field,emptyState} from '../../packages/ui/index.js';
import {refOf,titleOf,TYPE_LABELS} from '../../packages/contracts/index.js';
import {normalizeRoute,parseRoute,routeHash} from './routes.js';

const mountPoint=document.getElementById('app');
const navDefs=[['chronicle','◎','岁月史书'],['knowledge','⌘','思想体系'],['library','▤','材料藏书'],['sources','↳','原材料与摘录'],['personas','♧','云上人物']];
let currentRoute='',currentParams={},activeModule=null,atlasModule=null,selection={placeRefs:[],occurrenceTime:null},navigationSerial=0,mapHidden=false,readerOpen=false,readerTab='directory';
const stack=[];const controls={},ownCommits=new Set();let saveRefreshTimer,seenSequence=0,seenWorkspace='',polling=false,savedMapView=null;
document.documentElement.dataset.theme=localStorage.getItem('chronicle-theme')||'light';

function notify(message,tone='info'){
 const node=el('div',{className:'toast '+(tone==='error'?'error':'')},message);document.getElementById('notifications').append(node);setTimeout(()=>node.remove(),tone==='error'?9000:4200);
}
function installStyle(route){const names={chronicle:'chronicle',knowledge:'knowledge',sources:'knowledge',personas:'personas',library:'library',convert:'converter'};const name=names[route];if(!name||document.querySelector(`link[data-feature="${name}"]`))return;const link=el('link',{rel:'stylesheet',href:`/features/${name}/style.css`});link.dataset.feature=name;document.head.append(link);}
function baseContext(params){return{api,params,selection:structuredClone(selection),navigate,openObject,notify,refresh:refreshShell,onLocate:()=>{if(currentRoute==='chronicle'){mapHidden=false;readerOpen=false;applyMap();controls.atlasHost?.querySelector('input[type="search"],input')?.focus();}},onDiscuss:ref=>navigate('personas',{contextRefs:[ref]}),onDevelop:ref=>navigate('knowledge',{seedRefs:[ref]}),onAdopt:proposal=>api.adopt(proposal)};}
async function refreshShell(){
 try{const stats=await api.stats();const n=stats.counts?.entry||0;controls.savedCount.textContent=`${n} 条记录 · 保存在本机`;if(atlasModule&&(await atlasModule.refresh?.())===false)return false;return true;}catch(error){controls.savedCount.textContent='本机服务暂未连接';return false;}
}
async function pollExternalChanges(){
 if(document.hidden||polling)return;polling=true;
 try{
  const changes=await request('/changes?after='+seenSequence);if(changes.workspaceId!==seenWorkspace)return;
  const external=changes.items.some(e=>['entry','place'].includes(e.objectType)&&!ownCommits.has(e.commitId));
  if(external){if(!(await refreshShell()))return;if(currentRoute==='chronicle'&&(await activeModule?.refresh?.({external:true}))===false)return;notify('史书已同步其他窗口或工具的更新');}
  if(currentRoute==='library'&&changes.items.some(e=>['publication','annotation'].includes(e.objectType)&&!ownCommits.has(e.commitId)))await activeModule?.refresh?.({external:true,events:changes.items.filter(e=>!ownCommits.has(e.commitId))});
  seenSequence=changes.nextSequence;for(const event of changes.items)ownCommits.delete(event.commitId);
 }catch{}finally{polling=false;}
}
function showReader(tab=readerTab){readerOpen=true;readerTab=tab;applyMap();}
function updateMapSize(){if(currentRoute==='chronicle'&&controls.layout?.isConnected)controls.layout.style.setProperty('--map-height',Math.max(360,innerHeight-controls.layout.getBoundingClientRect().top)+'px');}
function applyMap(){
 if(currentRoute==='chronicle'){savedMapView={readerOpen,readerTab,mapHidden};if(seenWorkspace)sessionStorage.setItem('chronicle-map-view:'+seenWorkspace,JSON.stringify(savedMapView));}
 controls.layout?.classList.toggle('reading-focus',mapHidden&&readerOpen);
 controls.readerPane?.toggleAttribute('hidden',!readerOpen);
 if(controls.readerPane)controls.readerPane.dataset.view=readerTab;
 if(controls.directoryButton){controls.directoryButton.hidden=readerOpen;controls.directoryButton.setAttribute('aria-expanded',String(readerOpen));}
 controls.readerTabs?.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===readerTab)));
 if(controls.focusButton){controls.focusButton.textContent=mapHidden?'回到地图':'专注阅读';controls.focusButton.setAttribute('aria-pressed',String(mapHidden));}
}
async function navigate(route,params={},options={}){
 ({route,params}=normalizeRoute(route,params));
 const serial=++navigationSerial;const routeName=navDefs.find(n=>n[0]===route)?.[2]||(route==='settings'?'工作空间':'岁月史书');
 if(!['chronicle','knowledge','sources','personas','settings','library'].includes(route))route='chronicle';
 let returnParams=currentParams;
 try{
  if(activeModule){const leaving=activeModule;await leaving.dispose?.();returnParams=leaving.getNavigationState?.()||currentParams;if(currentRoute==='chronicle')returnParams={...returnParams,mapView:{readerOpen,readerTab,mapHidden}};activeModule=null;}if(atlasModule){await atlasModule.dispose?.();atlasModule=null;}
 }catch(error){notify(error.message,'error');return false;}
 if(serial!==navigationSerial)return false;
 if(currentRoute&&!options.back)stack.push({route:currentRoute,params:structuredClone(returnParams),scroll:window.scrollY});
 currentRoute=route;currentParams=params;controls.back.disabled=stack.length===0;
 const url=new URL(location.href);url.hash=routeHash(route,params);history.replaceState(null,'',url);
 controls.breadcrumb.textContent=route==='chronicle'?'云下 / 岁月史书':route==='settings'?'工作空间 / 设置':'云上 / '+routeName;
 controls.nav.querySelectorAll('[data-route]').forEach(b=>{if(b.dataset.route===route)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
 controls.settingsButton.toggleAttribute('data-active',route==='settings');controls.view.replaceChildren();controls.view.classList.toggle('map-page',route==='chronicle');installStyle(route);
 if(route==='settings'){activeModule=await mountSettings(controls.view);return true;}
 const descriptions={convert:'先转换与检查，再加入藏书。',library:'沿着书页阅读，在原文旁留下思考。',chronicle:'让关注过的世界，留下自己的记录。',knowledge:'把材料、概念与判断，组织成你的理解。',sources:'保存原文与出处，让每一个引用都有来处。',personas:'以留下的文字为起点，继续一场讨论。'};
 const intro=el('div',{className:'page-intro'},el('div',{},el('h1',{},routeName),el('p',{},descriptions[route])));
 controls.view.append(intro);
 try{
  if(route==='chronicle'){
   intro.classList.add('sr-only');
   const remembered=params.mapView||savedMapView;readerOpen=!!(params.objectId||params.newEntry||remembered?.readerOpen);readerTab=params.objectId||params.newEntry?'reader':remembered?.readerTab||'directory';mapHidden=remembered?.mapHidden||false;
   controls.layout=el('div',{className:'map-workspace'});controls.atlasHost=el('section',{className:'atlas-host','aria-label':'时间与地图'});
   controls.directoryButton=button('记录目录',()=>{readerOpen=!readerOpen;readerTab='directory';mapHidden=false;applyMap();},'button map-directory-toggle');controls.directoryButton.setAttribute('aria-controls','map-reader');
   const articleHost=el('section',{className:'chronicle-host','aria-label':'史书正文'});
   controls.readerTabs=el('div',{className:'reader-tabs','aria-label':'记录面板'});
   for(const [tab,label]of [['directory','记录目录'],['reader','正文 / 书写']]){const b=button(label,()=>showReader(tab),'button ghost');b.dataset.tab=tab;controls.readerTabs.append(b);}
   controls.focusButton=button('专注阅读',()=>{mapHidden=!mapHidden;applyMap();},'button ghost');
   const close=button('收起',()=>{readerOpen=false;mapHidden=false;applyMap();controls.directoryButton.focus();},'button ghost');close.setAttribute('aria-label','收起记录面板');
   controls.readerPane=el('aside',{id:'map-reader',className:'map-reader','aria-label':'记录与书写'},el('header',{className:'map-reader-bar'},controls.readerTabs,el('div',{className:'row'},controls.focusButton,close)),articleHost);
   controls.layout.append(controls.atlasHost,controls.directoryButton,controls.readerPane);controls.view.append(controls.layout);applyMap();updateMapSize();
   const [chronicle,atlas]=await Promise.all([import('../../features/chronicle/index.js'),import('../../features/atlas/index.js')]);
   if(serial!==navigationSerial)return;
   const chronicleApi={...api,list:query=>api.list(query?.objectType==='draft'?{...query,draftKind:'chronicle'}:query)};
   let mounted=false;
   activeModule=await chronicle.mount(articleHost,{...baseContext(params),api:chronicleApi,onViewChange:tab=>{if(mounted)showReader(tab);}});mounted=true;
   atlasModule=await atlas.mount(controls.atlasHost,{...baseContext(params),layout:'map',onSelection:(next,meta)=>{selection=structuredClone(next);activeModule?.setContext?.(selection);const writing=readerOpen&&readerTab==='reader'&&articleHost.querySelector('.chronicle-editor');if(meta?.reason!=='restore'&&!writing)showReader('directory');}});
  }else{
   const feature=route==='library'?'library':route==='personas'?'personas':'knowledge';const host=el('section',{className:'module-host','aria-label':routeName});controls.view.append(host);
   const module=await import(`/features/${feature}/index.js`);if(serial!==navigationSerial)return;
   activeModule=await module.mount(host,baseContext({...params,mode:route==='sources'?'sources':params.mode}));
  }
  await refreshShell();if(options.scroll!==undefined)window.scrollTo(0,options.scroll);
 }catch(error){controls.view.append(el('div',{className:'panel module-error',role:'alert'},el('h2',{},'这一页暂时没有打开'),el('p',{className:'muted'},error.message),button('重新打开',()=>navigate(route,params,{back:true}))));}
 return true;
}
async function openObject(objectId,revision){
 try{const object=await api.get(objectId,{revision,includeDeleted:true});const route=object.objectType==='draft'&&object.data.draftKind?object.data.draftKind:{entry:'chronicle',draft:'chronicle',predictionReview:'chronicle',knowledge:'knowledge',document:'knowledge',source:'sources',publication:'library',annotation:'library',persona:'personas',discussion:'personas',message:'personas'}[object.objectType]||'knowledge';await navigate(route,{objectId,revision});}catch(error){notify(error.message,'error');}
}
async function goBack(){const prev=stack.pop();if(prev){const moved=await navigate(prev.route,prev.params,{back:true,scroll:prev.scroll});if(moved===false){stack.push(prev);controls.back.disabled=false;}}}
async function newEntry(){if(currentRoute==='chronicle'&&activeModule?.newEntry){showReader('reader');await activeModule.newEntry();}else await navigate('chronicle',{newEntry:true});}

async function globalSearch(initial=''){
 const dialog=el('dialog',{className:'search-dialog','aria-label':'查找整个工作空间'}),query=el('input',{type:'search',value:initial,placeholder:'标题、正文或材料里的词…','aria-label':'搜索整个工作空间'}),results=el('div',{className:'search-results','aria-live':'polite'}),count=el('p',{className:'muted small'});let generation=0,timer;
 const close=()=>dialog.close();dialog.append(el('div',{className:'row'},el('h2',{},'查找你的积累'),button('关闭',close,'button ghost')),query,count,results);document.body.append(dialog);dialog.addEventListener('close',()=>{clearTimeout(timer);dialog.remove();});dialog.showModal();
 async function search(){const current=++generation;results.textContent='正在查找…';try{const found=await api.list({objectTypes:['entry','draft','knowledge','document','source','publication','annotation','persona','discussion'],q:query.value.trim(),limit:50,summary:true});if(current!==generation||!dialog.isConnected)return;count.textContent=`找到 ${found.total} 项${found.total>50?' · 显示前 50 项，可继续输入缩小范围':''}`;results.replaceChildren(...found.items.map(object=>{const row=button('',()=>{close();openObject(object.id);},'search-result');row.append(el('span',{className:'badge'},TYPE_LABELS[object.objectType]||'内容'),el('span',{},titleOf(object)));return row;}));if(!found.items.length)results.append(el('p',{className:'muted'},'没有找到匹配内容，可以换一个词。'));}catch(error){results.replaceChildren(el('p',{className:'error'},error.message),button('重试',search));}}
 query.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(search,180);});await search();query.focus();query.select();
}

async function mountSettings(container){
 let disposed=false;const data=await api.settings();const grid=el('div',{className:'settings-grid'});const model=el('section',{className:'panel'}),backup=el('section',{className:'panel'}),appearance=el('section',{className:'panel'}),agent=el('section',{className:'panel agent-interface'});
 const endpoint=el('input',{value:data.endpoint,placeholder:'https://…/v1/chat/completions','aria-label':'模型服务地址'});const modelName=el('input',{value:data.model,placeholder:'模型名称','aria-label':'模型名称'});const key=el('input',{type:'password',placeholder:data.hasApiKey?'已保存；留空则沿用':'如服务需要，填写密钥',autocomplete:'new-password','aria-label':'模型服务密钥'});
 const status=el('p',{className:'description'},data.configured?'已配置。人物会使用你选定的资料进行讨论。':'尚未连接模型。史书、体系与资料的使用不受影响。');
 const clearKey=el('input',{type:'checkbox','aria-label':'清除已保存密钥'});
 const save=button('保存连接设置',async()=>{save.disabled=true;try{const result=await api.saveSettings({endpoint:endpoint.value,model:modelName.value,...(clearKey.checked?{apiKey:''}:key.value?{apiKey:key.value}:{})});status.textContent=result.configured?'连接设置已保存，讨论时会显示使用的材料范围。':'设置已保存。补充服务地址和模型名后即可开始讨论。';key.value='';key.placeholder=result.hasApiKey?'已保存；留空则沿用':'如服务需要，填写密钥';clearKey.checked=false;notify('连接设置已保存');}catch(e){notify(e.message,'error');}finally{save.disabled=false;}},'button primary');
 model.append(el('h2',{},'人物讨论服务'),el('p',{className:'description'},'连接支持聊天接口的服务。每次只发送人物已选资料与当前讨论上下文；密钥保留在本机，不包含在工作空间备份中。'),field('接口地址',endpoint),field('模型',modelName),field('密钥',key),el('label',{className:'row small'},clearKey,'清除已保存密钥'),save,status);
 const progress=el('div',{className:'backup-status','aria-live':'polite'});
 const showProgress=p=>{if(disposed)return;const labels={preparing:'准备备份',snapshot:'生成一致快照','verify-revisions':'核验所有修订',database:'复制正文数据库',attachment:'复制附件',attachments:'复制附件',upload:'传入备份',complete:'正在完成'};const label=labels[p.phase]||'校验与复制';const amount=p.totalBytes?`${(p.completedBytes/1024/1024).toFixed(1)} / ${(p.totalBytes/1024/1024).toFixed(1)} MiB`:p.completedObjects?`${p.completedObjects} 个修订已核验`:'正在处理…';const bar=el('progress',{max:p.totalBytes||1,'aria-label':label});if(p.totalBytes)bar.value=p.completedBytes;progress.replaceChildren(el('p',{},label+' · '+amount),bar);};
 const exportButton=button('导出完整备份',async()=>{exportButton.disabled=true;importButton.disabled=true;progress.textContent='正在准备完整备份，包含所有修订和已导入的附件…';try{const r=await api.exportBackup(showProgress);const a=el('a',{href:r.url,download:r.name},'下载备份');progress.replaceChildren(el('span',{},`备份已生成 · ${(r.size/1024/1024).toFixed(1)} MiB　`),a);a.click();}catch(e){progress.textContent=e.message;notify(e.message,'error');}finally{exportButton.disabled=false;importButton.disabled=false;}});
 const importer=el('input',{type:'file',accept:'.chronicle','aria-label':'选择史书备份文件'});const importButton=button('恢复为新工作空间',async()=>{const file=importer.files[0];if(!file){notify('先选择一个完整备份文件。','error');return;}importButton.disabled=true;exportButton.disabled=true;progress.textContent='正在校验并恢复。原工作空间会保留，完成后切换到恢复的内容。';try{await api.importBackup(file,showProgress);progress.textContent='恢复完成，即将打开新的工作空间。';location.href='/';}catch(e){progress.textContent='恢复未完成：'+e.message;notify(e.message,'error');}finally{importButton.disabled=false;exportButton.disabled=false;}});
 backup.append(el('h2',{},'带走你的积累'),el('p',{className:'description'},'完整备份保留正文、草稿、修订、时空归属、引用、人物资料和讨论。恢复会创建新的工作空间，不覆盖当前内容。'),exportButton,el('hr'),field('从备份恢复',importer),importButton,progress);
 const theme=el('select',{'aria-label':'外观'},el('option',{value:'light'},'浅色 · 纸页'),el('option',{value:'dark'},'深色 · 夜读'));theme.value=document.documentElement.dataset.theme;theme.addEventListener('change',()=>{document.documentElement.dataset.theme=theme.value;localStorage.setItem('chronicle-theme',theme.value);});
 appearance.append(el('h2',{},'阅读与工作空间'),field('外观',theme),el('p',{className:'description'},'内容保存在运行服务的本机。无需模型连接即可阅读、记录和查找。请定期导出备份。'),el('p',{className:'small muted'},'岁月史书 0.2.0 · 个人工作空间'));
 const connection=el('pre',{hidden:true,tabIndex:0,'aria-label':'MCP 连接配置'});
 const copyConnection=button('复制 MCP 连接配置',async()=>{try{const value=JSON.stringify(await request('/operations/connection'),null,2);connection.textContent=value;connection.hidden=false;try{await navigator.clipboard.writeText(value);notify('连接配置已复制，可添加到支持本地 MCP 的模型客户端。');}catch{notify('配置已显示，可选中并复制。');}}catch(e){notify(e.message,'error');}});
 agent.append(el('h2',{},'让模型操作史书'),el('p',{className:'description'},'将本地工具接入你使用的模型客户端，就可以说“在某日、某地记下这件事”。支持查询地点与日期、创建和修改记录、创建及删除恢复自定义地点。'),el('p',{className:'description'},'同名地点需要明确选择，修改会核对版本，重试不会重复记录。客户端通过本机工具执行操作，史书服务需要保持运行。'),copyConnection,el('p',{className:'small'},el('a',{href:'/api/operations/schema',target:'_blank',rel:'noopener'},'查看接口与参数说明')),connection);
 grid.append(model,agent,backup,appearance);container.append(el('div',{className:'page-intro'},el('div',{},el('h1',{},'工作空间'),el('p',{},'管理连接、备份与阅读偏好。'))),grid);return{dispose(){disposed=true;}};
}

async function start(){
 const initial=await api.init();seenWorkspace=initial.workspaceId;seenSequence=(await api.stats()).sequence;try{const stored=JSON.parse(sessionStorage.getItem('chronicle-map-view:'+seenWorkspace));if(stored&&typeof stored.readerOpen==='boolean'&&['reader','directory'].includes(stored.readerTab))savedMapView=stored;}catch{}const sidebar=el('aside',{className:'sidebar'}),main=el('div',{className:'workspace-main'});
 sidebar.append(el('div',{className:'brand'},el('img',{src:'/apps/client/mark.svg',alt:''}),el('div',{},el('div',{className:'brand-name'},'岁月史书'),el('div',{className:'brand-subtitle'},'CHRONICLE OF MY WORLD'))));
 const nav=el('nav',{className:'nav-list','aria-label':'主导航'},el('div',{className:'nav-label'},'我的世界'));
 navDefs.forEach(([route,icon,label])=>nav.append(el('button',{type:'button',className:'nav-item',dataset:{route},onClick:()=>navigate(route)},el('span',{className:'nav-icon','aria-hidden':true},icon),label)));sidebar.append(nav);controls.nav=nav;
 controls.settingsButton=button('工作空间设置',()=>navigate('settings'),'nav-item');controls.savedCount=el('p',{className:'sidebar-note'},'保存在本机');sidebar.append(el('div',{className:'sidebar-bottom'},controls.settingsButton,controls.savedCount,el('p',{className:'sidebar-note'},'每一笔关注，都是史书的一页。')));
 controls.back=button('←',goBack,'button ghost');controls.back.setAttribute('aria-label','返回上一处');controls.back.disabled=true;controls.breadcrumb=el('span',{},'云下 / 岁月史书');
 const search=el('input',{type:'search',placeholder:'查找所有内容…','aria-label':'全局搜索'});const searchForm=el('form',{className:'global-search',onSubmit:async event=>{event.preventDefault();await globalSearch(search.value);}},search);
 const topbar=el('header',{className:'topbar'},el('div',{className:'page-breadcrumb'},controls.back,controls.breadcrumb),el('div',{className:'topbar-actions'},searchForm,button('＋ 记一笔',newEntry,'button primary')));
 controls.view=el('main',{className:'view-host',id:'main-content'});main.append(topbar,controls.view);mountPoint.replaceChildren(el('div',{className:'app-shell'},sidebar,main));
 const shellResize=new ResizeObserver(updateMapSize);shellResize.observe(sidebar);shellResize.observe(topbar);window.addEventListener('resize',updateMapSize);
 window.addEventListener('workspace-change',e=>{if(e.detail?.commitId)ownCommits.add(e.detail.commitId);if(e.detail?.objects?.every(o=>o.objectType==='draft'))return;clearTimeout(saveRefreshTimer);saveRefreshTimer=setTimeout(refreshShell,100);});
 setInterval(pollExternalChanges,2500);document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollExternalChanges();});
 document.addEventListener('keydown',e=>{if(e.isComposing)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();e.stopImmediatePropagation();const input=document.querySelector('.search-dialog[open] input')||search;input.focus();input.select();}if(e.altKey&&e.key==='ArrowLeft'){e.preventDefault();goBack();}});
 const initialRoute=parseRoute(location.hash);await navigate(initialRoute.route,initialRoute.params,{back:true});
 window.addEventListener('hashchange',()=>{const next=parseRoute(location.hash);navigate(next.route,next.params).catch(error=>notify(error.message,'error'));});
}
start().catch(error=>{mountPoint.replaceChildren(el('div',{className:'boot-state'},el('h1',{},'工作空间还未连接'),el('p',{},error.message),button('重新连接',()=>location.reload())));});
