import {DomainError,createChange,changeFor} from '../../packages/contracts/index.js';
import {parseTime,toRange,rangeToTimeSpec} from './time.js';

function checkedView(view){
  if(!view||view.objectType!=='timeView'||view.deletedAt)throw new DomainError('INVALID_INPUT','请选择一个现有时间图层');
  const range=toRange(view.data.timeSpec||view.data.query);
  if(!range.indexed)throw new DomainError('INVALID_INPUT','这个图层没有可拆分或合并的时间范围');
  return range;
}
function checkedName(name){const result=String(name||'').trim();if(!result)throw new DomainError('INVALID_INPUT','请为图层命名');return result;}
export function renameTimeView(view,name){if(!view||view.objectType!=='timeView'||view.deletedAt)throw new DomainError('INVALID_INPUT','请选择一个现有时间图层');return changeFor(view,{...view.data,name:checkedName(name)});}
export function removeTimeView(view){if(!view||view.objectType!=='timeView')throw new DomainError('INVALID_INPUT','请选择一个时间图层');return changeFor(view,view.data,{deleted:true});}
export function splitTimeView(view,at,names){
  const range=checkedView(view),boundarySpec=parseTime(at),boundary=toRange(boundarySpec);
  if(!boundary.indexed||boundarySpec.kind!=='instant'||boundarySpec.approximate)throw new DomainError('INVALID_INPUT','分界请填写一个明确的年、月或日；后一个图层从该时间单位的第一天开始');
  const cut=boundary.startDay;
  if(cut<=range.startDay||cut>=range.endDayExclusive)throw new DomainError('INVALID_INPUT','分界必须在图层范围内部，拆分后两段都需要有时间');
  const specs=[rangeToTimeSpec(range.startDay,cut),rangeToTimeSpec(cut,range.endDayExclusive)];
  return [...specs.map((timeSpec,i)=>createChange('timeView',{...view.data,name:checkedName(names?.[i]||`${view.data.name} · ${i===0?'前段':'后段'}`),timeSpec})),removeTimeView(view)];
}
export function mergeTimeViews(views,name){
  if(!Array.isArray(views)||views.length<2||new Set(views.map(v=>v?.id)).size!==views.length)throw new DomainError('INVALID_INPUT','至少选择两个不同图层进行合并');
  const ranges=views.map(checkedView).sort((a,b)=>a.startDay-b.startDay);
  let start=ranges[0].startDay,end=ranges[0].endDayExclusive;
  for(const range of ranges.slice(1)){if(range.startDay>end)throw new DomainError('INVALID_INPUT','这些图层之间有未覆盖的时间，请选择相接或重叠的图层，以免把空隙算入合并范围');end=Math.max(end,range.endDayExclusive);}
  return [createChange('timeView',{name:checkedName(name),timeSpec:rangeToTimeSpec(start,end)}),...views.map(removeTimeView)];
}
