import {overlaps} from '../../features/atlas/time.js';

const indexes=new WeakMap();
function compact(object){const {body,blocks,contextSnapshot,...data}=object.data;return{...object,data};}

/** Disposable metadata cache; committed objects and event watermarks remain authoritative. */
export function projectionIndex(workspace){
 let index=indexes.get(workspace);
 if(!index){
  const entries=workspace.list({objectType:'entry',includeDeleted:true,summary:true,limit:1000000});
  const places=workspace.list({objectType:'place',includeDeleted:true,summary:true,limit:1000000});
  index={entries:new Map(entries.items.map(o=>[o.id,o])),places:new Map(places.items.map(o=>[o.id,o])),sequence:places.sequence};indexes.set(workspace,index);
 }
 let batch=workspace.changesSince(index.sequence);
 while(batch.items.length){
  const changed=new Map(batch.items.filter(e=>['entry','place'].includes(e.objectType)).map(e=>[e.objectId,e]));
  for(const event of changed.values()){
   const object=workspace.get(event.objectId,{includeDeleted:true});index[object.objectType==='entry'?'entries':'places'].set(object.id,compact(object));
  }
  index.sequence=batch.nextSequence;if(index.sequence===batch.sequence)break;batch=workspace.changesSince(index.sequence);
 }
 index.sequence=batch.sequence;
 return index;
}

export function timeFilteredIds(index,spec,options={}){
 const requested=options.ids?new Set(options.ids):null,ids=[];
 for(const entry of index.entries.values()){
  if(requested&&!requested.has(entry.id))continue;
  if(options.onlyDeleted?!entry.deletedAt:!options.includeDeleted&&entry.deletedAt)continue;
  if(entry.data.occurrenceTime&&overlaps(entry.data.occurrenceTime,spec))ids.push(entry.id);
 }
 return ids;
}
