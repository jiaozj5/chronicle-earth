import {cpLength,toCodePoint,toUtf16,quoteTarget} from './model.js';

function length(node){if(node.nodeType===3)return cpLength(node.data);if(node.nodeType!==1)return 0;if(node.dataset.atom)return 1;return[...node.childNodes].reduce((n,c)=>n+length(c),0);}
function offset(root,node,index,edge){
 if(root===node)return root.nodeType===3?toCodePoint(root.data,index):[...root.childNodes].slice(0,index).reduce((n,c)=>n+length(c),0);
 if(root.nodeType===1&&root.dataset.atom&&root.contains(node))return edge==='end'?1:0;
 let total=0;for(const child of root.childNodes){if(child===node||child.contains?.(node))return total+offset(child,node,index,edge);total+=length(child);}return total;
}
export function captureSelection(root,blocks,selection=window.getSelection()){
 if(!selection?.rangeCount||selection.isCollapsed)return[];
 const range=selection.getRangeAt(0);if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return[];
 const targets=[];
 for(const node of root.querySelectorAll('[data-block-content]')){
  if(!range.intersectsNode(node))continue;const b=blocks.find(b=>b.id===node.dataset.blockContent);if(!b)continue;
  const start=node.contains(range.startContainer)?offset(node,range.startContainer,range.startOffset,'start'):0;
  const end=node.contains(range.endContainer)?offset(node,range.endContainer,range.endOffset,'end'):cpLength(b.text);
  if(end>start)targets.push(quoteTarget(b,start,end));
 }
 return targets;
}
export function selectionRects(content,target){
 const rectangles=[];
 for(const span of content.querySelectorAll('[data-run-start]')){
  const start=Number(span.dataset.runStart),end=Number(span.dataset.runEnd);
  if(target.end<=start||target.start>=end)continue;
  if(span.dataset.atom){rectangles.push(span.getBoundingClientRect());continue;}
  const node=span.firstChild;if(!node||node.nodeType!==3)continue;const range=document.createRange();range.setStart(node,toUtf16(node.data,Math.max(0,target.start-start)));range.setEnd(node,toUtf16(node.data,Math.min(end-start,target.end-start)));rectangles.push(...range.getClientRects());
 }
 return rectangles.filter(r=>r.width>0&&r.height>0);
}
export function copyTargets(blocks,targets){return targets.map(t=>{
 const block=blocks.find(b=>b.id===t.blockId);if(!block)return'';let at=0;return block.runs.map(r=>{const raw=r.atom?'\uFFFC':r.text,start=at;at+=cpLength(raw);if(t.kind==='text'&&(t.end<=start||t.start>=at))return'';if(r.atom==='formula')return r.latex?`$${r.latex}$`:r.mathml||'[公式]';if(r.atom==='image')return r.alt||'[图片]';return Array.from(raw).slice(t.kind==='text'?Math.max(0,t.start-start):0,t.kind==='text'?Math.min(at-start,t.end-start):undefined).join('');}).join('');}).join('\n\n');}
const POINT_MARKS=new Set(['filled-dot','hollow-circle','cross','check','slash']);
export function regionTarget(start,end,bounds,markType,pageIndex,{allowClick=false}={}){
 if(!bounds.width||!bounds.height)return null;
 const x1=Math.max(0,Math.min(bounds.width,start.x)),y1=Math.max(0,Math.min(bounds.height,start.y)),x2=Math.max(0,Math.min(bounds.width,end.x)),y2=Math.max(0,Math.min(bounds.height,end.y));
 let x=Math.min(x1,x2),y=Math.min(y1,y2),w=Math.abs(x2-x1),h=Math.abs(y2-y1);
 if(Math.hypot(w,h)<5){
  if(!POINT_MARKS.has(markType)&&!allowClick)return null;
  const size=POINT_MARKS.has(markType)?[24,24]:markType==='triangle'?[60,50]:['highlight','underline'].includes(markType)?[120,22]:[100,55];
  w=Math.min(size[0],bounds.width);h=Math.min(size[1],bounds.height);x=Math.max(0,Math.min(bounds.width-w,x2-w/2));y=Math.max(0,Math.min(bounds.height-h,y2-h/2));
 }else{w=Math.min(bounds.width,Math.max(4,w));h=Math.min(bounds.height,Math.max(4,h));x=Math.min(x,bounds.width-w);y=Math.min(y,bounds.height-h);}
 return{kind:'region',pageIndex,rect:[x/bounds.width,y/bounds.height,w/bounds.width,h/bounds.height]};
}
export function svgMark(svg,mark,rects,{selected=false,placement='text'}={}){
 const NS='http://www.w3.org/2000/svg';const add=(tag,attrs)=>{const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));svg.append(n);return n;};
 if(['circle','triangle','rectangle'].includes(mark.type)&&rects.length>1){const left=Math.min(...rects.map(r=>r.x)),top=Math.min(...rects.map(r=>r.y));rects=[{x:left,y:top,width:Math.max(...rects.map(r=>r.x+r.width))-left,height:Math.max(...rects.map(r=>r.y+r.height))-top}];}
 for(const{x,y,width:w,height:h}of rects){const c=mark.color||'#d49d3a',stroke=selected?3:1.7,base={fill:'none',stroke:c,'stroke-width':stroke,'vector-effect':'non-scaling-stroke'};
  if(mark.type==='highlight')add('rect',{x,y,width:w,height:h,fill:c,opacity:mark.opacity??.28});
  else if(mark.type==='underline')add('path',{d:`M${x},${y+h-1}h${w}`,...base});
  else if(mark.type==='rectangle')add('rect',{x,y,width:w,height:h,rx:2,...base});
  else if(mark.type==='circle')add('ellipse',{cx:x+w/2,cy:y+h/2,rx:w/2+3,ry:h/2+3,...base});
  else if(mark.type==='triangle')add('path',{d:`M${x+w/2},${y}L${x+w},${y+h}L${x},${y+h}Z`,...base});
  else if(['filled-dot','hollow-circle'].includes(mark.type))add('circle',{cx:placement==='region'?x+w/2:x+w+7,cy:y+h/2,r:placement==='region'?Math.max(2,Math.min(w,h)/6):4,...base,fill:mark.type==='filled-dot'?c:'none'});
  else {const sw=placement==='region'?w/2:12,sh=placement==='region'?h/2:12,left=placement==='region'?x+w/2-sw/2:x+w+2,top=y+h/2-sh/2;const d=mark.type==='check'?`M${left},${top+sh/2}l${sw/3},${sh/2}l${sw*2/3},${-sh}`:mark.type==='cross'?`M${left},${top}l${sw},${sh}m0,${-sh}l${-sw},${sh}`:`M${left},${top+sh}l${sw},${-sh}`;add('path',{d,...base});}
 }
}
