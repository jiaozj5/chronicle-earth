export const wheelPixels=(delta,mode,height=600)=>delta*(mode===1?16:mode===2?height:1);
export const wheelZoom=(scale,delta)=>Math.max(.5,Math.min(3,scale*Math.exp(-Math.max(-150,Math.min(150,delta))*.002)));

// One page per wheel gesture. Inertia and scrolling to the bottom of a magnified
// page cannot accidentally cascade into subsequent pages.
export function wheelPager(){
 let last=-Infinity,sum=0,direction=0,consumed=false;
 return{feed(delta,time,{scrollable=false,busy=false}={}){
  const sign=Math.sign(delta);if(!sign)return 0;
  if(time-last>180||(sign!==direction&&time-last>80)){sum=0;consumed=false;}last=time;direction=sign;
  if(scrollable||busy){consumed=true;return 0;}if(consumed)return 0;
  sum=sign===Math.sign(sum)?sum+delta:delta;
  if(Math.abs(sum)<40)return 0;consumed=true;return sign;
 },reset(){last=-Infinity;sum=0;consumed=false;direction=0;}};
}

export function bindReaderWheel({root,stage,pager,isBlocked,isReader,getScale,onZoom,onTurn,now=()=>performance.now()}){
 const magnify=e=>{if(!isReader()||!(e.ctrlKey||e.metaKey)||!e.deltaY)return;e.preventDefault();e.stopPropagation();onZoom(wheelZoom(getScale(),wheelPixels(e.deltaY,e.deltaMode,stage.clientHeight)),{x:e.clientX,y:e.clientY});};
 const flip=e=>{if(e.ctrlKey||e.metaKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)||!e.deltaY)return;const delta=wheelPixels(e.deltaY,e.deltaMode,stage.clientHeight),scrollable=delta>0?stage.scrollTop+stage.clientHeight<stage.scrollHeight-2:stage.scrollTop>2;if(scrollable){pager.feed(delta,now(),{scrollable:true});return;}e.preventDefault();const direction=pager.feed(delta,now(),{busy:isBlocked()});if(direction)onTurn(direction);};
 root.addEventListener('wheel',magnify,{capture:true,passive:false});stage.addEventListener('wheel',flip,{passive:false});
 return()=>{root.removeEventListener('wheel',magnify,true);stage.removeEventListener('wheel',flip);};
}
