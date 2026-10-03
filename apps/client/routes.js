// Old conversion links remain valid, but conversion belongs to the library.
export function normalizeRoute(route,params={}){
 if(route==='convert')return{route:'library',params:{...params,section:'convert'}};
 return{route:route||'chronicle',params};
}
export function parseRoute(hash){
 const [route,query]=hash.replace(/^#/,'').split('?'),p=new URLSearchParams(query||'');
 return normalizeRoute(route,{
  ...(p.get('id')?{objectId:p.get('id')}:{}),
  ...(p.get('revision')?{revision:Number(p.get('revision'))}:{}),
  ...(p.get('rendition')?{renditionId:p.get('rendition')}:{}),
  ...(p.get('section')==='convert'?{section:'convert'}:{})
 });
}
export function routeHash(route,params={}){
 ({route,params}=normalizeRoute(route,params));const query=new URLSearchParams();
 if(route==='library'&&params.section==='convert')query.set('section','convert');
 if(params.objectId)query.set('id',params.objectId);
 if(params.revision)query.set('revision',String(params.revision));
 if(params.renditionId)query.set('rendition',params.renditionId);
 return '#'+route+(query.size?'?'+query:'');
}
