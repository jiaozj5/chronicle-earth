import {assert, validateChange} from '../../packages/contracts/index.js';
import {validateEntry, prepareReviewChange} from '../../features/chronicle/service.js';
import {validateKnowledge, validateDocument, validateSource, validateRelation, validateRef, referencesIn, validateCitation} from '../../features/knowledge/service.js';
import {validatePersona} from '../../features/personas/service.js';
import {toRange} from '../../features/atlas/time.js';
import {isCustomPlace} from '../../features/atlas/service.js';

function validateTime(value){
 if(value==null)return;
 assert(typeof value==='object'&&typeof value.originalText==='string','时间需要保留原始表达。');
 assert(['instant','duration','uncertain','unknown'].includes(value.kind),'时间类型无效。');
 const range=toRange(value);
 assert(!['日期无效','开始时间晚于结束时间'].includes(range.reason),range.reason||'时间范围无效。');
}
function coordinate(value){return Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&Math.abs(value[0])<=180&&Math.abs(value[1])<=90;}
function validatePlace(data){
 assert(typeof data.name==='string'&&data.name.trim(),'地点需要一个名称。');
 assert(['city','settlement','region','naturalFeature','route','custom'].includes(data.kind),'地点尺度无效。');
 if(data.coordinates!=null)assert(coordinate(data.coordinates),'地图坐标无效。');
 if(data.geometry){const g=data.geometry;assert(['LineString','Polygon'].includes(g.type),'地点范围需要路线或区域。');const rings=g.type==='LineString'?[g.coordinates]:g.coordinates;assert(Array.isArray(rings)&&rings.length>0,'地点范围不能为空。');for(const ring of rings){assert(Array.isArray(ring)&&ring.length>=(g.type==='LineString'?2:4)&&ring.every(coordinate),'地点范围中的坐标无效。');if(g.type==='Polygon')assert(JSON.stringify(ring[0])===JSON.stringify(ring.at(-1)),'区域边界需要闭合。');}}
}

/** The HTTP boundary validates domain invariants before storage handles atomicity. */
export async function validateCommit(workspace,body){
 assert(body&&Array.isArray(body.changes)&&body.changes.length>0,'没有可保存的内容。');
 const changes=body.changes;
 for(const c of changes)validateChange(c);
 const snapshots=new Map();
 const previous=async c=>{if(!c.expectedRevision)return null;const key=c.id+'@'+c.expectedRevision;if(!snapshots.has(key))snapshots.set(key,await workspace.get(c.id,{revision:c.expectedRevision,includeDeleted:true}));return snapshots.get(key);};
 const objectFor=async ref=>{
  const pending=changes.find(c=>c.id===ref.targetId&&(ref.versionMode==='live'||ref.revision===c.expectedRevision+1));
  if(pending)return{id:pending.id,objectType:pending.objectType,revision:pending.expectedRevision+1,deletedAt:pending.deleted?new Date().toISOString():null,data:pending.data};
  return workspace.get(ref.targetId,{revision:ref.versionMode==='pinned'?ref.revision:undefined,includeDeleted:true});
 };
 for(const c of changes){
  const data=c.data,before=await previous(c);
  if(before)assert(before.objectType===c.objectType,'保存前后内容类型不能改变。');
  if(c.objectType==='place')assert(isCustomPlace({id:c.id,objectType:'place',data}), '内置导航地点不可修改或删除，请另建自定义地点。');
  // Completed messages and frozen discussions are written only by the discussion service.
  assert(!['message','discussion','adoption','publication','annotation','importJob','libraryOperation'].includes(c.objectType),'这类内容需要通过对应领域操作保存。');
  if(c.deleted){assert(before,'不能删除尚未保存的内容。');continue;}
  switch(c.objectType){
   case 'entry':
    validateEntry(data);validateTime(data.occurrenceTime);
    if(before?.data.kind==='prediction')assert(data.kind==='prediction','预言保留原有身份；可另写一条普通记录。');
    if(before?.data.initialPredictionRevision)assert(data.initialPredictionRevision===before.data.initialPredictionRevision,'首次预言版本不能改变。');
    if(data.kind==='prediction'&&!before?.data.initialPredictionRevision)assert(data.initialPredictionRevision===c.expectedRevision+1,'首次预言需要固定当前版本。');
    for(const p of data.placeRefs){const place=await objectFor({targetId:p.placeId,versionMode:'live'});assert(place.objectType==='place','记录的地点归属无效。');}
    break;
   case 'draft':assert(typeof data.body==='string','草稿正文必须为文字。');break;
   case 'knowledge':validateKnowledge(data);break;
   case 'document':validateDocument(data);break;
   case 'source':validateSource(data);break;
   case 'persona':validatePersona(data);break;
   case 'place':validatePlace(data);break;
   case 'timeView':assert(typeof (data.name||data.title)==='string'&&(data.name||data.title).trim(),'时间图层需要名称。');validateTime(data.timeSpec||data.occurrenceTime);break;
   case 'predictionReview':{
    prepareReviewChange(data,null,c.id);const prediction=await objectFor(data.predictionRef);assert(prediction.objectType==='entry'&&prediction.data.kind==='prediction','复盘需要引用一条预言。');break;
   }
   case 'relation':validateRelation(data,await objectFor(data.from),await objectFor(data.to));break;
   case 'citation':validateRef(data.ref);break;
  }
  const previousRefs=new Set(referencesIn(before||{data:{}}).map(({ref})=>JSON.stringify(ref)));
  for(const {ref} of referencesIn({objectType:c.objectType,data})){
   if(previousRefs.has(JSON.stringify(ref)))continue;
   const checked=validateCitation(ref,await objectFor(ref));assert(checked.valid,checked.message,checked.code);
  }
 }
 return body;
}
