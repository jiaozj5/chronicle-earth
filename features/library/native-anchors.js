const compact=text=>text.replace(/\s/gu,'');
// Never guess between repeated blocks. Only whitespace differences are tolerated.
export function nativeAnchorSpan(visible,block,target){
 const points=Array.from(block);if(!Number.isInteger(target.start)||!Number.isInteger(target.end)||target.start<0||target.end>points.length||target.end<=target.start||points.slice(target.start,target.end).join('')!==target.exact)return null;
 const hay=compact(visible),needle=compact(block);if(!needle)return null;const at=hay.indexOf(needle);if(at<0||hay.indexOf(needle,at+1)!==-1)return null;
 const start=at+compact(points.slice(0,target.start).join('')).length,end=at+compact(points.slice(0,target.end).join('')).length;return end>start?[start,end]:null;
}
const maps=new WeakMap();
export function nativeAnnotationRects(layer,block,target,bounds){
 if(!layer)return[];const source=layer.textContent;let map=maps.get(layer);
 if(!map||map.source!==source){const nodes=[],walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT);let text='',node;while((node=walker.nextNode())){let offset=0;for(const char of node.data){if(!/\s/u.test(char)){text+=char;for(let i=0;i<char.length;i++)nodes.push({node,start:offset,end:offset+char.length});}offset+=char.length;}}map={source,text,nodes};maps.set(layer,map);}
 const span=nativeAnchorSpan(map.text,block,target);if(!span)return[];const first=map.nodes[span[0]],last=map.nodes[span[1]-1];if(!first||!last)return[];const range=document.createRange();range.setStart(first.node,first.start);range.setEnd(last.node,last.end);const seen=new Set();
 return[...range.getClientRects()].filter(r=>{if(r.width<=0||r.height<=0)return false;const key=[r.x,r.y,r.width,r.height].map(n=>n.toFixed(2)).join(',');if(seen.has(key))return false;seen.add(key);return true;}).map(r=>({x:r.x-bounds.x,y:r.y-bounds.y,width:r.width,height:r.height}));
}
