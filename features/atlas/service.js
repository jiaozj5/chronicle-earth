import {toRange,overlaps} from './time.js';
import {localizePlace} from './names.js';

/** The shipped navigation catalogue owns this reserved prefix; old custom UUIDs remain editable. */
export function isCustomPlace(place){return !!place&&place.objectType==='place'&&typeof place.id==='string'&&!place.id.startsWith('place_ne_');}

export function isLocatable(place){const d=place?.data||place;return !!(d&&((Array.isArray(d.coordinates)&&d.coordinates.length===2&&d.coordinates.every(Number.isFinite)&&Math.abs(d.coordinates[0])<=180&&Math.abs(d.coordinates[1])<=90)||d.geometry?.coordinates?.length));}
export function searchPlaces(places,query,limit=20){
  places=places.map(localizePlace);
  const q=String(query||'').trim().toLocaleLowerCase();
  return places.filter(p=>!p.deletedAt).map(p=>{const d=p.data||p;const names=[d.name,...(d.aliases||[]).map(a=>typeof a==='string'?a:a.name)].filter(Boolean).map(s=>s.toLocaleLowerCase());let score=!q?1:names.some(s=>s===q)?4:names.some(s=>s.startsWith(q))?3:names.some(s=>s.includes(q))?2:0;return{p,score};}).filter(x=>x.score).sort((a,b)=>b.score-a.score||(a.p.data?.rank??9)-(b.p.data?.rank??9)||a.p.id.localeCompare(b.p.id)).slice(0,limit).map(x=>x.p);
}
export function projectAtlas(entries,places,timeSpec=null,options={}){
  places=places.map(localizePlace);
  const pmap=new Map(places.filter(p=>!p.deletedAt).map(p=>[p.id,p]));
  const map=new Map(),total=new Set(),visible=new Set();let unlocatedCount=0;
  const views=Array.isArray(timeSpec)?timeSpec:timeSpec?[timeSpec]:null;
  const ranges=views?.map(toRange);const q=String(options.q||'').toLocaleLowerCase();
  const allowed=options.placeIds?new Set(options.placeIds):null;
  const matched=options.matchedEntryIds==null?null:options.matchedEntryIds instanceof Set?options.matchedEntryIds:new Set(options.matchedEntryIds);
  for(const entry of entries){
    if(entry.objectType&&entry.objectType!=='entry'||entry.deletedAt)continue;
    const d=entry.data||entry;if(d.status!=='adopted')continue;
    const range=toRange(d.occurrenceTime);
    const refs=[...new Set((d.placeRefs||[]).filter(r=>r.confirmed===true&&pmap.has(r.placeId)&&isLocatable(pmap.get(r.placeId))).map(r=>r.placeId))];
    if(!range.indexed||!refs.length){unlocatedCount++;continue;}
    if(ranges&&!ranges.some(r=>overlaps(range,r)))continue;
    const show=(!options.kind||d.kind===options.kind)&&(matched?matched.has(entry.id):!q||`${d.title||''}\n${d.body||''}`.toLocaleLowerCase().includes(q));
    total.add(entry.id);
    for(const placeId of refs){
      if(!map.has(placeId)){const place=pmap.get(placeId),pd=place.data||place;map.set(placeId,{placeId,name:pd.name,kind:pd.kind,coordinates:pd.coordinates??null,geometry:pd.geometry,recordCount:0,visibleCount:0,explored:true,ids:new Set(),visibleIds:new Set()});}
      const marker=map.get(placeId);marker.ids.add(entry.id);
      if(show&&(!allowed||allowed.has(placeId))){marker.visibleIds.add(entry.id);visible.add(entry.id);}
    }
  }
  const markers=[...map.values()].map(({ids,visibleIds,...m})=>({...m,recordCount:ids.size,visibleCount:visibleIds.size,entryIds:[...ids],visibleEntryIds:[...visibleIds]}));
  return {markers,total:total.size,visibleTotal:visible.size,explored:markers.map(m=>m.placeId),unlocatedCount};
}

/** Screen-space grouping changes presentation only. Selected places stay individual. */
export function clusterMarkers(markers,project,cellSize=72,selectedIds=[]){
  const selected=new Set(selectedIds),cells=new Map();const separate=[];
  for(const marker of markers){if(!marker.coordinates)continue;const point=project(marker.coordinates);if(!point||!point.every(Number.isFinite))continue;
    if(selected.has(marker.placeId)){separate.push({...marker,x:point[0],y:point[1],members:[marker],count:marker.recordCount});continue;}
    const key=`${Math.floor(point[0]/cellSize)},${Math.floor(point[1]/cellSize)}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push({...marker,x:point[0],y:point[1]});}
  return [...separate,...[...cells.values()].map(members=>{const ids=new Set(members.flatMap(m=>m.entryIds||[]));return {placeId:members.length===1?members[0].placeId:null,name:members.length===1?members[0].name:`${members.length} 个地点`,x:members.reduce((n,m)=>n+m.x,0)/members.length,y:members.reduce((n,m)=>n+m.y,0)/members.length,count:ids.size,members};})];
}

/** Greedy collision-free labels, ordered by caller's importance. */
export function placeLabels(candidates,width,height){const boxes=[];const result=[];for(const c of candidates){const w=Math.max(40,[...c.label].reduce((n,char)=>n+(/[\u0000-\u00ff]/.test(char)?6.5:12),0)+14),h=23;const attempts=[[c.x+9,c.y-18],[c.x-w-9,c.y-18],[c.x-w/2,c.y+10],[c.x-w/2,c.y-h-13]];for(const [x,y]of attempts){if(x<4||y<4||x+w>width-4||y+h>height-4)continue;if(boxes.some(b=>x<b.x+b.w+5&&x+w+5>b.x&&y<b.y+b.h+4&&y+h+4>b.y))continue;const box={x,y,w,h};boxes.push(box);result.push({...c,...box});break;}}return result;}
