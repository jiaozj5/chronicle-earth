// Geometry is normalized to the source page, independent of viewport and zoom.
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export function transformRegion(target,handle,dx,dy,bounds){
 const [x,y,w,h]=target.rect,px=dx/bounds.width,py=dy/bounds.height;
 if(handle==='move')return{...target,rect:[clamp(x+px,0,1-w),clamp(y+py,0,1-h),w,h]};
 const minW=Math.min(8/bounds.width,1),minH=Math.min(8/bounds.height,1);let l=x,t=y,r=x+w,b=y+h;
 if(handle.includes('w'))l=clamp(x+px,0,r-minW);if(handle.includes('e'))r=clamp(x+w+px,l+minW,1);
 if(handle.includes('n'))t=clamp(y+py,0,b-minH);if(handle.includes('s'))b=clamp(y+h+py,t+minH,1);
 return{...target,rect:[l,t,r-l,b-t]};
}
export function regionControls(overlay,target,bounds,{id='',index=0,selected=false,label=''}){
 const [x,y,w,h]=target.rect.map((n,i)=>n*(i%2?bounds.height:bounds.width)),NS='http://www.w3.org/2000/svg';
 const add=(tag,attrs)=>{const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));overlay.append(n);return n;};
 const hit=add('rect',{x,y,width:Math.max(w,12),height:Math.max(h,12),fill:'transparent',class:'lib-region-hit','data-region-id':id,'data-region-index':index,'data-region-handle':'move',role:'button','aria-label':'移动'+label,tabindex:0});
 if(!selected)return hit;
 add('rect',{x,y,width:w,height:h,fill:'none',class:'lib-region-outline'});
 for(const [handle,hx,hy]of [['nw',x,y],['n',x+w/2,y],['ne',x+w,y],['e',x+w,y+h/2],['se',x+w,y+h],['s',x+w/2,y+h],['sw',x,y+h],['w',x,y+h/2]])add('rect',{x:hx-5,y:hy-5,width:10,height:10,rx:2,class:'lib-region-handle','data-region-id':id,'data-region-index':index,'data-region-handle':handle,'aria-label':'调整'+label+'大小 '+handle,role:'button',tabindex:0});
 return hit;
}
