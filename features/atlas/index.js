import {parseTime,toRange,formatTime} from './time.js';
import {searchPlaces,clusterMarkers,placeLabels,isCustomPlace} from './service.js';
import {localizePlace,placeLabel} from './names.js';
import {createChange} from '../../packages/contracts/index.js';
import {renameTimeView,removeTimeView,splitTimeView,mergeTimeViews} from './view-operations.js';
import {createPlaceGeometry,parseCoordinates} from './geometry.js';

const ROOT=new URL('.',import.meta.url);
let d3Promise;
function loadD3(){if(globalThis.d3)return Promise.resolve(globalThis.d3);return d3Promise||=(new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=new URL('data/vendor/d3.min.js',ROOT);s.onload=()=>resolve(globalThis.d3);s.onerror=()=>{d3Promise=null;reject(new Error('本地地图绘制资源未能加载'));};document.head.append(s);}));}
function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e;}
function btn(text,fn,className=''){const b=el('button','atlas-button '+className,text);b.type='button';b.addEventListener('click',fn);return b;}
function input(placeholder){const i=el('input','atlas-input');i.placeholder=placeholder;return i;}
const kindLabels={city:'城市',settlement:'聚落',region:'地区',naturalFeature:'自然地理',route:'路线',custom:'自定义'};
function storageGet(){try{return JSON.parse(sessionStorage.getItem('chronicle-atlas-view')||'null');}catch{return null;}}
export async function mount(container,ctx){
  if(!document.querySelector('link[data-atlas-style]')){const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('style.css',ROOT);css.dataset.atlasStyle='';document.head.append(css);}
  let disposed=false,places=[],placesLoaded=false,placesError='',timeViews=[],projectionData={markers:[],total:0,explored:[]},d3,landPath,riversPath,geoProjection,geoPath;
  let refreshToken=0,frame=0,width=600,height=390,hits=[],drag=null,view=storageGet()||{k:1,center:[30,18]},activeTimeViewId='',drawing=null;
  let selection={placeRefs:[...(ctx.selection?.placeRefs||[])],occurrenceTime:ctx.selection?.occurrenceTime||null};
  const mapLayout=ctx.layout==='map';
  const root=el('section','atlas-panel'+(mapLayout?' atlas-layout-map':''));root.setAttribute('aria-label','时间与地点');
  const heading=el('div','atlas-heading');heading.append(el('div','atlas-eyebrow','云下 · 地球'),el('h2','atlas-title','沿着岁月，留下你的记录'));
  const timeRow=el('form','atlas-time-row'),timeInput=input('全部时间 · 例如 1850—1900');timeInput.setAttribute('aria-label','时间范围');timeInput.value=selection.occurrenceTime?.originalText||'';
  const apply=el('button','atlas-button','进入');apply.type='submit';timeRow.append(timeInput,apply);
  const timeHelp=el('div','atlas-time-help');timeHelp.setAttribute('aria-live','polite');
  const savedRow=el('div','atlas-saved-row'),savedSelect=el('select','atlas-select');savedSelect.setAttribute('aria-label','已保存的时间图层');
  const saveTime=btn('保存图层',async()=>{if(!selection.occurrenceTime)return notify('先输入一个时间范围');const name=window.prompt('为这个时间图层命名',formatTime(selection.occurrenceTime));if(!name?.trim())return;try{await ctx.api.commit([createChange('timeView',{name:name.trim(),timeSpec:selection.occurrenceTime})]);notify('时间图层已保存');await refresh();}catch(e){notify(e.message,'error');}});
  const allTime=btn('全部时间',()=>{activeTimeViewId='';savedSelect.value='';setTime(null);});
  const manageTime=btn('管理图层',()=>{timeManager.hidden=!timeManager.hidden;if(!timeManager.hidden)renderTimeManager();});
  savedRow.append(savedSelect,saveTime,allTime,manageTime);
  const timeManager=el('div','atlas-time-manager');timeManager.hidden=true;timeManager.setAttribute('aria-label','管理时间图层');
  const placeArea=el('div','atlas-place-area'),search=input('找一个地方 · 城市、旧名或别名');search.setAttribute('aria-label','搜索地点');search.autocomplete='off';
  const results=el('div','atlas-search-results');results.hidden=true;results.setAttribute('aria-label','地点候选');
  const selected=el('div','atlas-selected');selected.setAttribute('aria-label','已选地点');
  const customButton=btn('＋ 自定义地点',openCustom,'atlas-link');
  const managePlaces=btn('管理自定义地点',()=>{placeManager.hidden=!placeManager.hidden;if(!placeManager.hidden){customArea.hidden=true;stopDrawing();renderPlaceManager();}},'atlas-link');
  const placeActions=el('div','atlas-inline-actions');placeActions.append(customButton,managePlaces);placeArea.append(search,results,selected);
  const mapWrap=el('div','atlas-map-wrap'),canvas=el('canvas','atlas-map');canvas.tabIndex=0;canvas.setAttribute('aria-label','地理地图，方向键平移，加减键缩放；也可使用地点搜索');canvas.setAttribute('role','img');
  const controls=el('div','atlas-controls');controls.append(btn('＋',()=>zoomAt(width/2,height/2,1.6)),btn('−',()=>zoomAt(width/2,height/2,1/1.6)),btn('全球',()=>{view={k:1,center:[30,18]};render();}));
  const mapStatus=el('div','atlas-map-status','正在加载本地地理资料…');mapStatus.setAttribute('role','status');mapWrap.append(canvas,controls,mapStatus);
  const summary=el('div','atlas-summary');summary.setAttribute('aria-live','polite');
  const legend=el('div','atlas-legend');legend.append(el('span','atlas-legend-dot',''),el('span','','点亮代表你在当前时期收录过记录'));
  const attribution=el('div','atlas-attribution','Natural Earth · 当代地理仅供定位；历史原名可以保留');
  const customArea=el('div','atlas-custom-area');customArea.hidden=true;
  const placeManager=el('div','atlas-place-manager');placeManager.hidden=true;placeManager.setAttribute('aria-label','管理自定义地点');
  const managerSearch=input('查找自己创建的地点');managerSearch.setAttribute('aria-label','搜索自定义地点');
  const deletedToggle=el('input');deletedToggle.type='checkbox';const deletedLabel=el('label','atlas-check');deletedLabel.append(deletedToggle,document.createTextNode('显示已删除地点'));
  const managerList=el('div','atlas-managed-list');managerList.setAttribute('aria-live','polite');
  placeManager.append(el('p','atlas-hint','这里只列出你创建的地点。删除后可恢复，关联记录的正文和历史地名会保留。'),managerSearch,deletedLabel,managerList,btn('收起地点管理',()=>{placeManager.hidden=true;managePlaces.focus();}));
  let managedPlaces=[],managerToken=0;
  managerSearch.addEventListener('input',renderManagedList);deletedToggle.addEventListener('change',renderManagedList);
  if(mapLayout){
    const tools=el('div','atlas-floating-tools'),toolHeading=el('div','atlas-tool-heading'),toolBody=el('div','atlas-tool-body');toolBody.id='atlas-map-tools';
    const toggleTools=btn('收起工具',()=>{toolBody.hidden=!toolBody.hidden;toggleTools.textContent=toolBody.hidden?'展开工具':'收起工具';toggleTools.setAttribute('aria-expanded',String(!toolBody.hidden));});toggleTools.setAttribute('aria-expanded','true');toggleTools.setAttribute('aria-controls',toolBody.id);
    toolHeading.append(el('strong','','时间与地点'),toggleTools);
    const more=el('details','atlas-more-tools');more.append(el('summary','','图层与地点管理'),savedRow,timeManager,placeActions,customArea,placeManager);
    toolBody.append(timeRow,timeHelp,placeArea,more);tools.append(toolHeading,toolBody);
    const footer=el('div','atlas-map-footer');footer.append(summary,legend,attribution);root.append(mapWrap,tools,footer);
  }else{placeArea.append(placeActions);root.append(heading,timeRow,timeHelp,savedRow,timeManager,placeArea,customArea,placeManager,mapWrap,summary,legend,attribution);}
  container.replaceChildren(root);

  function notify(text,tone){ctx.notify?.(text,tone);}
  function publish(reason='selection'){ctx.onSelection?.({placeRefs:selection.placeRefs.map(r=>({...r})),occurrenceTime:selection.occurrenceTime},{reason});renderSelection();}
  function renderSelection(){selected.replaceChildren();for(const ref of selection.placeRefs){const p=places.find(p=>p.id===ref.placeId);const chip=btn(`${(/[\u3400-\u9fff]/.test(ref.originalName||'')?ref.originalName:p?.data?.name)||ref.originalName||'已选地点'} ×`,()=>{selection.placeRefs=selection.placeRefs.filter(r=>r.placeId!==ref.placeId);publish();render();},'atlas-chip');chip.title='取消这个地点的选择';selected.append(chip);}if(!selection.placeRefs.length)selected.append(el('span','atlas-empty-selection','尚未选地点 · 记录也可以暂不定位'));}
  function selectPlace(place,append=false){const term=search.value.trim();const names=[place.data.name,...(place.data.aliases||[]).map(a=>typeof a==='string'?a:a.name)];const originalName=names.some(n=>n?.toLocaleLowerCase()===term.toLocaleLowerCase())?term:place.data.name;const ref={placeId:place.id,originalName,confirmed:true};selection.placeRefs=append?[...selection.placeRefs.filter(r=>r.placeId!==place.id),ref]:[ref];results.hidden=true;search.value='';publish('place');if(place.data.coordinates){view.center=[...place.data.coordinates];view.k=Math.max(view.k,5);}render();}
  function timeDisplay(){if(!selection.occurrenceTime){timeHelp.textContent='所有已索引时期；新记录的时间可稍后填写';return;}const r=toRange(selection.occurrenceTime);timeHelp.textContent=r.indexed?formatTime(selection.occurrenceTime):`${selection.occurrenceTime.originalText} · ${r.reason}，仍可保留为记录原文`;}
  async function setTime(value){selection.occurrenceTime=value;timeInput.value=value?.originalText||'';timeDisplay();publish('time');await refreshProjection();}
  timeRow.addEventListener('submit',e=>{e.preventDefault();try{const value=timeInput.value.trim()?parseTime(timeInput.value):null;const r=value?toRange(value):null;if(r?.reason==='开始时间晚于结束时间')throw Error(r.reason);timeInput.removeAttribute('aria-invalid');activeTimeViewId='';savedSelect.value='';setTime(value);}catch(error){timeInput.setAttribute('aria-invalid','true');timeHelp.textContent=error.message;timeInput.focus();}});
  savedSelect.addEventListener('change',()=>{activeTimeViewId=savedSelect.value;const v=timeViews.find(t=>t.id===activeTimeViewId);if(v)setTime(v.data.timeSpec||v.data.query);if(!timeManager.hidden)renderTimeManager();});
  function renderTimeManager(){
    timeManager.replaceChildren();
    const intro=el('p','atlas-hint','图层只是观看的时间范围。以下操作只整理图层，记录内容和身份始终保留。');
    const close=btn('收起管理',()=>{timeManager.hidden=true;manageTime.focus();});
    timeManager.append(intro,close);
    if(!timeViews.length){timeManager.append(el('p','atlas-hint','先输入时间范围并保存一个图层。'));return;}
    const target=el('select','atlas-select');target.setAttribute('aria-label','要管理的图层');
    for(const item of timeViews){const option=el('option','',item.data.name);option.value=item.id;target.append(option);}
    target.value=timeViews.some(v=>v.id===activeTimeViewId)?activeTimeViewId:timeViews[0].id;
    const rename=input('图层名称');rename.setAttribute('aria-label','新的图层名称');
    const range=el('p','atlas-hint'),error=el('p','atlas-error');error.setAttribute('role','alert');
    const actions=el('div','atlas-inline-actions');
    const current=()=>timeViews.find(v=>v.id===target.value);
    const update=()=>{rename.value=current()?.data.name||'';range.textContent=formatTime(current()?.data.timeSpec);error.textContent='';};
    target.addEventListener('change',update);update();
    async function commitViews(changes,success){
      const buttons=[...timeManager.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);error.textContent='';
      try{const response=await ctx.api.commit(changes);await refresh();notify(success);return response;}catch(e){error.textContent=e.message;notify(e.message,'error');return null;}finally{buttons.forEach(b=>b.disabled=false);}
    }
    actions.append(btn('改名',async()=>{try{const response=await commitViews([renameTimeView(current(),rename.value)],'图层名称已修改');if(response)renderTimeManager();}catch(e){error.textContent=e.message;}}));
    const deleteConfirm=el('div','atlas-confirm');deleteConfirm.hidden=true;
    deleteConfirm.append(el('p','atlas-hint','删除该图层后，所有记录仍然保留。'),btn('确认删除图层',async()=>{const old=current();const response=await commitViews([removeTimeView(old)],'图层已删除，记录仍然保留');if(response){if(activeTimeViewId===old.id){activeTimeViewId='';await setTime(null);}renderTimeManager();}}),btn('保留图层',()=>deleteConfirm.hidden=true));
    actions.append(btn('删除图层',()=>deleteConfirm.hidden=!deleteConfirm.hidden));
    const splitSection=el('div','atlas-manager-section');splitSection.append(el('strong','','拆成两段'));
    const splitAt=input('分界，如 1900 或 1900年6月1日');splitAt.setAttribute('aria-label','图层拆分时间');
    const splitHelp=el('p','atlas-hint','后段从分界的第一天开始，前段止于其前一天。例如在 1900 年拆分，后段从 1900 年 1 月 1 日开始。');
    splitSection.append(splitAt,splitHelp,btn('拆分图层',async()=>{try{const response=await commitViews(splitTimeView(current(),splitAt.value),'已拆成两个图层，记录没有复制');if(response){activeTimeViewId='';savedSelect.value='';renderTimeManager();}}catch(e){error.textContent=e.message;splitAt.focus();}}));
    const mergeSection=el('div','atlas-manager-section');mergeSection.append(el('strong','','合并相接或重叠的图层'));
    const choices=el('div','atlas-merge-choices');
    for(const item of timeViews){const label=el('label','atlas-check'),checkbox=el('input');checkbox.type='checkbox';checkbox.value=item.id;checkbox.checked=item.id===target.value;label.append(checkbox,document.createTextNode(item.data.name));choices.append(label);}
    const mergeName=input('合并后的图层名称');mergeName.setAttribute('aria-label','合并后的图层名称');
    mergeSection.append(choices,mergeName,btn('合并所选图层',async()=>{try{const ids=[...choices.querySelectorAll('input:checked')].map(i=>i.value);const response=await commitViews(mergeTimeViews(timeViews.filter(v=>ids.includes(v.id)),mergeName.value),'已合并图层，记录没有复制');if(response){const next=response.objects.find(o=>o.objectType==='timeView'&&!o.deletedAt);if(next){activeTimeViewId=next.id;savedSelect.value=next.id;await setTime(next.data.timeSpec);}renderTimeManager();}}catch(e){error.textContent=e.message;}}));
    timeManager.append(target,range,rename,actions,deleteConfirm,splitSection,mergeSection,error);
  }
  search.addEventListener('input',renderSearch);search.addEventListener('focus',renderSearch);
  search.addEventListener('keydown',e=>{if(e.key==='Escape'){results.hidden=true;search.blur();}if(e.key==='ArrowDown'){e.preventDefault();results.querySelector('button')?.focus();}if(e.key==='Enter'){const found=searchPlaces(places,search.value,20);if(found.length===1){e.preventDefault();selectPlace(found[0],e.shiftKey);}}});
  function renderSearch(){results.replaceChildren();if(!search.value.trim()){results.hidden=true;return;}results.hidden=false;if(!placesLoaded){results.append(el('p','atlas-search-empty',placesError?'地点目录暂未读取：'+placesError:'正在读取地点目录…'));if(placesError)results.append(btn('重试读取地点',()=>refresh()));return;}const found=searchPlaces(places,search.value,20);if(!found.length)results.append(el('p','atlas-search-empty','没有找到。可在下方创建地点，名称即可保存。'));for(const p of found){const row=el('div','atlas-search-row');const choice=btn('',()=>selectPlace(p));choice.append(el('strong','',p.data.name),el('small','',`${kindLabels[p.data.kind]||'地点'}${p.data.region&&(!p.id.startsWith('place_ne_')||/[\u3400-\u9fff]/.test(p.data.region))?' · '+p.data.region:''}${p.data.country?' · '+p.data.country:''}`));const add=btn('＋',()=>selectPlace(p,true),'atlas-add');add.title='加入当前多个地点';add.setAttribute('aria-label','同时选择 '+p.data.name);row.append(choice,add);results.append(row);}}
  async function renderPlaceManager(){
    const token=++managerToken;managerList.replaceChildren(el('p','atlas-hint','正在读取自定义地点…'));
    try{const result=await ctx.api.list({objectType:'place',includeDeleted:true,limit:100000});if(disposed||token!==managerToken)return;managedPlaces=result.items.filter(isCustomPlace);renderManagedList();}
    catch(e){if(!disposed&&token===managerToken){managerList.replaceChildren(el('p','atlas-error',e.message),btn('重试读取',renderPlaceManager));}}
  }
  function renderManagedList(){
    managerList.replaceChildren();const q=managerSearch.value.trim().toLocaleLowerCase();
    const matches=managedPlaces.filter(p=>Boolean(p.deletedAt)===deletedToggle.checked&&(!q||[p.data.name,...(p.data.aliases||[]).map(a=>typeof a==='string'?a:a.name)].some(n=>String(n||'').toLocaleLowerCase().includes(q))));
    if(!matches.length){managerList.append(el('p','atlas-hint',q?'没有符合名称的地点。':deletedToggle.checked?'没有已删除的自定义地点。':'还没有自定义地点。'));return;}
    for(const place of matches){
      const row=el('div','atlas-managed-place');row.dataset.placeId=place.id;
      const name=el('div','atlas-managed-name');name.append(el('strong','',place.data.name),el('small','atlas-hint',kindLabels[place.data.kind]||'地点'));row.append(name);
      if(place.deletedAt){
        const restore=btn('恢复',async()=>{restore.disabled=true;try{await ctx.api.restore(place);notify('地点已恢复，关联记录重新显示在地图上');await refresh();await renderPlaceManager();}catch(e){notify(e.message,'error');restore.disabled=false;}});restore.setAttribute('aria-label','恢复地点 '+place.data.name);row.append(restore);
      }else{
        const select=btn('定位',()=>selectPlace(place));select.setAttribute('aria-label','定位地点 '+place.data.name);
        const remove=btn('删除',async()=>{
          remove.disabled=true;confirm.replaceChildren(el('p','atlas-hint','正在读取关联记录…'));confirm.hidden=false;
          try{const related=await ctx.api.list({objectType:'entry',placeIds:[place.id],limit:1});if(disposed)return;
            confirm.replaceChildren(el('p','atlas-hint',`「${place.data.name}」关联 ${related.total} 条记录。删除地点后，记录正文与历史地名保留；地点可随时恢复。`));
            const yes=btn('确认删除地点',async()=>{yes.disabled=true;try{await ctx.api.remove(place);selection.placeRefs=selection.placeRefs.filter(r=>r.placeId!==place.id);publish('delete');notify('地点已删除，关联记录已保留');await refresh();await renderPlaceManager();}catch(e){notify(e.message,'error');yes.disabled=false;}});
            confirm.append(yes,btn('取消',()=>{confirm.hidden=true;remove.disabled=false;remove.focus();}));yes.focus();
          }catch(e){confirm.replaceChildren(el('p','atlas-error',e.message));remove.disabled=false;}
        });remove.setAttribute('aria-label','删除地点 '+place.data.name);
        const actions=el('div','atlas-inline-actions');actions.append(select,remove);row.append(actions);
      }
      const confirm=el('div','atlas-confirm');confirm.hidden=true;row.append(confirm);managerList.append(row);
    }
  }
  function openCustom(){
    customArea.hidden=!customArea.hidden;if(customArea.hidden){stopDrawing();return;}
    placeManager.hidden=true;
    stopDrawing();customArea.replaceChildren();const form=el('form','atlas-custom-form');
    const name=input('地点名称'),aliases=input('旧名或别名，用逗号分隔');name.required=true;name.setAttribute('aria-label','新地点名称');name.value=search.value;aliases.setAttribute('aria-label','地点别名');
    const kind=el('select','atlas-select');kind.setAttribute('aria-label','地点类型');for(const [value,text] of Object.entries(kindLabels)){const option=el('option','',text);option.value=value;kind.append(option);}kind.value='custom';
    const locate=el('input');locate.type='checkbox';const locationLabel=el('label','atlas-check');locationLabel.append(locate,document.createTextNode('使用地图中心作为大致位置'));
    const hint=el('p','atlas-hint','只写名称也能保存。没有位置的地点可以关联记录，暂不点亮地图。');
    const shapeArea=el('div','atlas-shape-area');shapeArea.hidden=true;
    const instructions=el('p','atlas-hint','点击地图依次取点，拖动地图可以移动视野。键盘方向键移动，Enter 取地图中心，Ctrl+Enter 结束，Esc 取消绘制。');
    const shapeStatus=el('p','atlas-hint');shapeStatus.setAttribute('role','status');
    const drawActions=el('div','atlas-inline-actions');
    const coordsLabel=el('label','atlas-coordinate-field');coordsLabel.append(el('span','atlas-hint','经纬度列表（每行：经度, 纬度；可直接修改）'));
    const coords=el('textarea','atlas-input atlas-coordinates');coords.rows=4;coords.setAttribute('aria-label','范围经纬度');coords.spellcheck=false;coordsLabel.append(coords);
    const shapeError=el('p','atlas-error');shapeError.setAttribute('role','alert');
    const shapeDraft={kind:'route',points:[],active:false,finished:false,onChange:syncShape};
    function syncShape(){coords.value=shapeDraft.points.map(p=>p.map(v=>Number(v.toFixed(5))).join(', ')).join('\n');shapeStatus.textContent=`已取 ${shapeDraft.points.length} 点${shapeDraft.finished?' · 范围已就绪':shapeDraft.active?' · 正在绘制':' · 可继续绘制或填写坐标'}`;shapeError.textContent='';render();}
    function activateDrawing(){if(!geoProjection){shapeError.textContent='地图暂不可用，请在经纬度列表填写范围。';return;}drawing=shapeDraft;shapeDraft.kind=kind.value;shapeDraft.active=true;shapeDraft.finished=false;canvas.classList.add('atlas-drawing');syncShape();canvas.focus();}
    function finishShape(){try{createPlaceGeometry(kind.value,shapeDraft.points);shapeDraft.active=false;shapeDraft.finished=true;canvas.classList.remove('atlas-drawing');syncShape();return true;}catch(e){shapeError.textContent=e.message;return false;}}
    shapeDraft.finish=finishShape;shapeDraft.cancel=()=>{shapeDraft.active=false;shapeDraft.finished=false;shapeDraft.points=[];canvas.classList.remove('atlas-drawing');syncShape();};
    drawActions.append(btn('在地图上绘制',activateDrawing),btn('取地图中心',()=>{drawing=shapeDraft;shapeDraft.kind=kind.value;shapeDraft.finished=false;shapeDraft.points.push([...view.center]);syncShape();}),btn('撤回上一个点',()=>{shapeDraft.points.pop();shapeDraft.finished=false;syncShape();}),btn('结束绘制',finishShape),btn('取消绘制',()=>{shapeDraft.cancel();}));
    coords.addEventListener('input',()=>{try{shapeDraft.points=parseCoordinates(coords.value);shapeDraft.kind=kind.value;shapeDraft.finished=false;shapeDraft.active=false;drawing=shapeDraft;canvas.classList.remove('atlas-drawing');shapeError.textContent='';shapeStatus.textContent=`已填 ${shapeDraft.points.length} 点 · 保存时会检查范围`;render();}catch(e){shapeError.textContent=e.message;}});
    shapeArea.append(instructions,drawActions,shapeStatus,coordsLabel,shapeError);
    kind.addEventListener('change',()=>{stopDrawing();shapeDraft.active=false;shapeDraft.finished=false;shapeDraft.kind=kind.value;shapeDraft.points=[];coords.value='';const isShape=['route','region'].includes(kind.value);shapeArea.hidden=!isShape;locationLabel.hidden=isShape;hint.textContent=isShape?'只标记这条路线或这片地区；不会把沿途或内部城市全部算作已探索。':'只写名称也能保存。没有位置的地点可以关联记录，暂不点亮地图。';syncShape();});
    const submit=el('button','atlas-button','保存地点');submit.type='submit';const cancel=btn('取消',()=>{stopDrawing();customArea.hidden=true;customButton.focus();});
    form.append(name,kind,aliases,locationLabel,hint,shapeArea,submit,cancel);
    form.addEventListener('submit',async e=>{e.preventDefault();submit.disabled=true;shapeError.textContent='';try{
      const data={name:name.value.trim(),kind:kind.value,userCreated:true,aliases:aliases.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),coordinates:locate.checked?[...view.center]:null};if(!data.name)return;
      if(['route','region'].includes(kind.value))Object.assign(data,createPlaceGeometry(kind.value,parseCoordinates(coords.value)));
      const response=await ctx.api.commit([createChange('place',data)]);const place=response.objects.find(o=>o.objectType==='place');if(!place)throw new Error('地点保存没有返回已保存对象');places.push(place);stopDrawing();customArea.hidden=true;selectPlace(place,true);notify('地点已保存');
    }catch(error){shapeError.textContent=error.message;notify(error.message,'error');}finally{submit.disabled=false;}});
    customArea.append(form);name.focus();
  }
  function stopDrawing(){if(drawing)drawing.active=false;drawing=null;canvas.classList.remove('atlas-drawing');render();}

  async function refreshProjection(){const token=++refreshToken;try{const params=selection.occurrenceTime?{time:JSON.stringify(selection.occurrenceTime)}:{};const data=await ctx.api.atlas(params);if(disposed||token!==refreshToken)return false;projectionData=data;summary.textContent=`${data.total??0} 条已定位记录 · ${(data.explored||[]).length} 个点亮地点${data.unlocatedCount?` · ${data.unlocatedCount} 条待定位`:''}`;render();return true;}catch(error){if(!disposed){summary.textContent=`探索数据暂不可用：${error.message}`;notify('地图计数加载失败，可继续记录与地点选择','error');}return false;}}
  async function refresh(){placesError='';if(!placesLoaded)renderSearch();const response=await Promise.allSettled([ctx.api.list({objectType:'place',limit:100000}),ctx.api.list({objectType:'timeView',limit:10000})]);if(disposed)return;if(response[0].status==='fulfilled'){places=response[0].value.items.map(localizePlace);placesLoaded=true;}else{placesError=response[0].reason.message;notify('地点目录暂不可用：'+placesError,'error');}if(response[1].status==='fulfilled')timeViews=response[1].value.items;savedSelect.replaceChildren();const placeholder=el('option','','已保存的图层');placeholder.value='';savedSelect.append(placeholder);for(const t of timeViews){const o=el('option','',t.data.name||'未命名图层');o.value=t.id;savedSelect.append(o);}savedSelect.value=timeViews.some(v=>v.id===activeTimeViewId)?activeTimeViewId:'';renderSelection();renderSearch();timeDisplay();const projected=await refreshProjection();return response.every(r=>r.status==='fulfilled')&&projected;}
  function transform(){const c=geoProjection(view.center);return {k:view.k,x:width/2-c[0]*view.k,y:height/2-c[1]*view.k};}
  function screen(coords){const p=geoProjection(coords),t=transform();return[p[0]*t.k+t.x,p[1]*t.k+t.y];}
  function inverse(x,y){const t=transform();return geoProjection.invert([(x-t.x)/t.k,(y-t.y)/t.k]);}
  function zoomAt(x,y,factor){if(!geoProjection)return;const anchor=inverse(x,y);view.k=Math.max(1,Math.min(64,view.k*factor));const p=screen(anchor),t=transform();view.center=geoProjection.invert([(width/2-t.x-(x-p[0]))/t.k,(height/2-t.y-(y-p[1]))/t.k]);clampCenter();render();}
  function clampCenter(){view.center[0]=((view.center[0]+540)%360)-180;view.center[1]=Math.max(-80,Math.min(80,view.center[1]));}
  function render(){if(frame||disposed)return;frame=requestAnimationFrame(()=>{frame=0;draw();});}
  function draw(){if(!d3||!geoProjection||disposed)return;const dark=document.documentElement.dataset.theme==='dark';const colors=dark?{water:'#202b29',land:'#29342c',shore:'#43544a',river:'#405e5a',fog:'rgba(31,40,35,.18)',ink:'#dce7d9',label:'#29382e',muted:'#adc2b1',active:'#b5d9b2',shape:'#8fb89c'}:{water:'#e8edeb',land:'#f1f0e8',shore:'#c5cdc6',river:'#b8c9c6',fog:'rgba(222,227,225,.18)',ink:'#213d2e',label:'#f1f4ef',muted:'#65716a',active:'#43795f',shape:'#638b7d'};const g=canvas.getContext('2d'),dpr=devicePixelRatio||1;g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,width,height);g.fillStyle=colors.water;g.fillRect(0,0,width,height);const t=transform();g.save();g.translate(t.x,t.y);g.scale(t.k,t.k);if(landPath){g.fillStyle=colors.land;g.fill(landPath);g.strokeStyle=colors.shore;g.lineWidth=.8/t.k;g.stroke(landPath);}if(riversPath){g.strokeStyle=colors.river;g.lineWidth=.6/t.k;g.globalAlpha=.65;g.stroke(riversPath);g.globalAlpha=1;}g.restore();g.fillStyle=colors.fog;g.fillRect(0,0,width,height);
    const selectedIds=selection.placeRefs.map(r=>r.placeId),markerById=new Map(projectionData.markers.map(m=>[m.placeId,m]));
    // Regional shapes represent only their own scale, never explore contained cities.
    const shapes=[...projectionData.markers,...places.filter(p=>selectedIds.includes(p.id)&&!markerById.has(p.id)&&p.data.geometry).map(p=>({geometry:p.data.geometry,recordCount:0}))];
    for(const marker of shapes){if(marker.geometry){g.save();g.translate(t.x,t.y);g.scale(t.k,t.k);const path=new Path2D(geoPath(marker.geometry));g.strokeStyle=marker.recordCount?colors.shape:colors.muted;g.lineWidth=2/t.k;g.setLineDash([5/t.k,4/t.k]);g.stroke(path);g.fillStyle=dark?'rgba(132,184,143,.08)':'rgba(82,132,111,.06)';if(/Polygon/.test(marker.geometry.type))g.fill(path);g.restore();}}
    if(drawing?.points.length){g.save();g.strokeStyle=colors.active;g.fillStyle=colors.active;g.lineWidth=2;g.setLineDash([5,4]);g.beginPath();drawing.points.forEach((p,i)=>{const[x,y]=screen(p);if(i===0)g.moveTo(x,y);else g.lineTo(x,y);});if(drawing.kind==='region'&&drawing.points.length>2)g.closePath();g.stroke();g.setLineDash([]);drawing.points.forEach((p,i)=>{const[x,y]=screen(p);g.beginPath();g.arc(x,y,4,0,Math.PI*2);g.fill();g.font='11px system-ui';g.fillText(String(i+1),x+7,y-7);});if(drawing.active){g.strokeStyle=colors.active;g.lineWidth=1;g.beginPath();g.moveTo(width/2-9,height/2);g.lineTo(width/2+9,height/2);g.moveTo(width/2,height/2-9);g.lineTo(width/2,height/2+9);g.stroke();}g.restore();}
    const display=projectionData.markers.map(m=>({...m,name:placeLabel(m.placeId,m.name)}));for(const p of places){if(selectedIds.includes(p.id)&&!markerById.has(p.id))display.push({placeId:p.id,name:p.data.name,coordinates:p.data.coordinates,recordCount:0,entryIds:[],explored:false});}
    const groups=clusterMarkers(display,screen,view.k>=12?30:64,selectedIds).filter(c=>c.x>-50&&c.x<width+50&&c.y>-50&&c.y<height+50);const candidates=[];hits=[];
    groups.sort((a,b)=>Number(selectedIds.includes(b.placeId))-Number(selectedIds.includes(a.placeId))||b.count-a.count);
    for(const c of groups){const active=selectedIds.includes(c.placeId);const explored=c.members.some(m=>m.explored!==false&&m.recordCount>0);if(explored){const glow=g.createRadialGradient(c.x,c.y,2,c.x,c.y,30);glow.addColorStop(0,'rgba(87,145,119,.2)');glow.addColorStop(1,'rgba(87,145,119,0)');g.fillStyle=glow;g.beginPath();g.arc(c.x,c.y,30,0,Math.PI*2);g.fill();}g.fillStyle=explored?'#43795f':'#65736b';g.strokeStyle=active?'#233e31':'#fff';g.lineWidth=active?2:1.5;g.beginPath();g.arc(c.x,c.y,active?6:c.members.length>1?6:4,0,Math.PI*2);g.fill();g.stroke();if(active){g.strokeStyle='#43795f';g.lineWidth=1;g.beginPath();g.arc(c.x,c.y,10,0,Math.PI*2);g.stroke();}const label=`${active?'✓ ':''}${c.name}${c.count?' · '+c.count:''}`;candidates.push({...c,label,active,recorded:explored});hits.push({x:c.x-11,y:c.y-11,w:22,h:22,group:c});}
    const known=new Set(display.map(m=>m.placeId));const base=places.filter(p=>p.data.coordinates&&!known.has(p.id)&&(p.data.rank??6)<=Math.log2(view.k)*1.6+2.5).map(p=>{const[x,y]=screen(p.data.coordinates);return{x,y,p};}).filter(p=>p.x>0&&p.x<width&&p.y>0&&p.y<height).sort((a,b)=>(a.p.data.rank??6)-(b.p.data.rank??6));
    for(const c of base.slice(0,110)){candidates.push({x:c.x,y:c.y,label:c.p.data.name,place:c.p,active:false,recorded:false});}
    for(const label of placeLabels(candidates,width,height)){g.save();g.font=`${label.active?'600 ':''}12px system-ui, sans-serif`;g.fillStyle=label.active?(dark?'#d4e4d7':'#486c57'):label.recorded?(dark?'#b6cbbd':'#728a79'):(dark?'#8da698':'#8b998f');g.textBaseline='middle';g.shadowColor=dark?'#1e2926aa':'#fafbf4aa';g.shadowBlur=2;g.fillText(label.label,label.x+7,label.y+label.h/2);g.restore();hits.push({x:label.x,y:label.y,w:label.w,h:label.h,group:label.members?label:null,place:label.place});}
    try{sessionStorage.setItem('chronicle-atlas-view',JSON.stringify(view));}catch{}
  }
  function resize(){const rect=mapWrap.getBoundingClientRect();width=Math.max(1,rect.width-(mapLayout?0:2));height=mapLayout?Math.max(1,rect.height):Math.max(300,Math.min(440,rect.height||390));const dpr=devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.style.width=width+'px';canvas.style.height=height+'px';if(d3){geoProjection=d3.geoMercator().scale(width/(2*Math.PI)).translate([width/2,height/2]);geoPath=d3.geoPath(geoProjection);if(land)landPath=new Path2D(geoPath(land));if(rivers)riversPath=new Path2D(geoPath(rivers));}render();}
  let land,rivers;const observer=new ResizeObserver(resize);observer.observe(mapWrap);
  canvas.addEventListener('wheel',e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoomAt(e.clientX-r.left,e.clientY-r.top,e.deltaY<0?1.17:1/1.17);},{passive:false});
  canvas.addEventListener('pointerdown',e=>{if(!geoProjection)return;canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,start:[e.clientX,e.clientY],center:[...view.center],moved:false};canvas.classList.add('atlas-dragging');});
  canvas.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(e.clientX-drag.start[0],e.clientY-drag.start[1])>4)drag.moved=true;const c=geoProjection(view.center);view.center=geoProjection.invert([c[0]-dx/view.k,c[1]-dy/view.k]);clampCenter();drag.x=e.clientX;drag.y=e.clientY;render();});
  canvas.addEventListener('pointerup',e=>{if(!drag)return;const moved=drag.moved;drag=null;canvas.classList.remove('atlas-dragging');if(moved)return;const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(drawing?.active){const point=inverse(x,y);point[0]=((point[0]+540)%360)-180;point[1]=Math.max(-85,Math.min(85,point[1]));drawing.points.push(point);drawing.onChange();return;}const hit=[...hits].reverse().find(h=>x>=h.x&&x<=h.x+h.w&&y>=h.y&&y<=h.y+h.h);if(hit?.place)selectPlace(hit.place,e.shiftKey);else if(hit?.group?.members.length===1){const p=places.find(p=>p.id===hit.group.members[0].placeId);if(p)selectPlace(p,e.shiftKey);}else if(hit?.group)zoomAt(hit.group.x,hit.group.y,2);});
  canvas.addEventListener('pointercancel',()=>{drag=null;canvas.classList.remove('atlas-dragging');});
  canvas.addEventListener('keydown',e=>{if(!geoProjection)return;if(drawing?.active&&e.key==='Enter'){e.preventDefault();if(e.ctrlKey||e.metaKey)drawing.finish();else{drawing.points.push([...view.center]);drawing.onChange();}return;}if(['+','=','-'].includes(e.key)){e.preventDefault();zoomAt(width/2,height/2,e.key==='-'?1/1.4:1.4);}const shifts={ArrowLeft:[-70,0],ArrowRight:[70,0],ArrowUp:[0,-70],ArrowDown:[0,70]};if(shifts[e.key]){e.preventDefault();const[dx,dy]=shifts[e.key],c=geoProjection(view.center);view.center=geoProjection.invert([c[0]+dx/view.k,c[1]+dy/view.k]);clampCenter();render();}});
  root.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(drawing?.active){e.preventDefault();e.stopPropagation();drawing.cancel();customArea.querySelector('.atlas-shape-area button')?.focus();}else if(!customArea.hidden){stopDrawing();customArea.hidden=true;customButton.focus();}else if(!timeManager.hidden){timeManager.hidden=true;manageTime.focus();}else if(!placeManager.hidden){placeManager.hidden=true;managePlaces.focus();}});
  const themeObserver=new MutationObserver(render);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  // Geography can finish after records and text navigation are already usable.
  (async()=>{try{const all=await Promise.all([loadD3(),fetch(new URL('data/land.geojson',ROOT)).then(r=>{if(!r.ok)throw Error('陆地图层读取失败');return r.json();}),fetch(new URL('data/rivers.geojson',ROOT)).then(r=>{if(!r.ok)throw Error('河流图层读取失败');return r.json();})]);if(disposed)return;[d3,land,rivers]=all;mapStatus.hidden=true;resize();}catch(e){if(!disposed){mapStatus.textContent=`${e.message}。可以继续使用上方地点搜索。`;canvas.hidden=true;controls.hidden=true;}}})();
  await refresh();
  return {refresh,setContext(next){selection={placeRefs:[...(next.placeRefs||[])],occurrenceTime:next.occurrenceTime||null};timeInput.value=selection.occurrenceTime?.originalText||'';renderSelection();timeDisplay();refreshProjection();},dispose(){disposed=true;observer.disconnect();themeObserver.disconnect();if(frame)cancelAnimationFrame(frame);}};
}
