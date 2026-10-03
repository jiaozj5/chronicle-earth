export function rememberedPage(storage,key,count){
 try{const value=JSON.parse(storage.getItem(key)||'null');return Number.isInteger(value?.pageIndex)?Math.max(0,Math.min(count-1,value.pageIndex)):0;}catch{return 0;}
}

// Serialise page changes, but coalesce queued inputs to the latest destination.
// A failed save/render cancels queued navigation rather than silently discarding a draft.
export function pageNavigator({current,count,turn}){
 let target=null,active=null,running=null;
 function go(index,blockId){
  if(!Number.isInteger(index)||index<0||index>=count())return Promise.resolve(false);
  target={index,blockId};
  if(!running)running=(async()=>{try{while(target){const next=target;target=null;active=next;await turn(next.index,next.blockId);}return true;}catch(e){target=null;throw e;}finally{running=null;active=null;}})();
  return running;
 }
 return{go,step(delta){return go((target?.index??active?.index??current())+delta);},get busy(){return !!running;}};
}
