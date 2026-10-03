import {DomainError} from '../../packages/contracts/index.js';
const invalid=message=>{throw new DomainError('INVALID_INPUT',message);};
function point(raw){if(!Array.isArray(raw)||raw.length!==2||!raw.every(Number.isFinite)||Math.abs(raw[0])>180||Math.abs(raw[1])>90)invalid('经度需在 -180 到 180 之间，纬度需在 -90 到 90 之间');return raw.map(v=>Math.round(v*100000)/100000);}
function unwrap(points){const result=[points[0].slice()];for(const p of points.slice(1)){let lon=p[0],last=result.at(-1)[0];while(lon-last>180)lon-=360;while(lon-last<-180)lon+=360;result.push([lon,p[1]]);}return result;}
function cross(a,b,c){return(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function intersects(a,b,c,d){const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);return x*y<0&&z*w<0;}
export function createPlaceGeometry(kind,input){
  if(!['route','region'].includes(kind))invalid('只有路线或地区需要绘制范围');
  const points=input.map(point).filter((p,i,all)=>i===0||p[0]!==all[i-1][0]||p[1]!==all[i-1][1]);
  if(kind==='region'&&points.length>1&&points[0][0]===points.at(-1)[0]&&points[0][1]===points.at(-1)[1])points.pop();
  const unique=new Set(points.map(p=>p.join(','))).size;
  if(unique<(kind==='route'?2:3))invalid(kind==='route'?'路线至少需要两个不同点':'地区至少需要三个不同点');
  if(unique!==points.length&&kind==='region')invalid('地区边界不能重复经过同一点，请撤回并重新选择');
  const unwrapped=unwrap(points);
  if(kind==='region'){
    const n=points.length;
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){if(j===i+1||(i===0&&j===n-1))continue;if(intersects(unwrapped[i],unwrapped[(i+1)%n],unwrapped[j],unwrapped[(j+1)%n]))invalid('地区边界交叉了，请撤回或调整坐标');}
    const area=unwrapped.reduce((sum,p,i)=>sum+p[0]*unwrapped[(i+1)%n][1]-unwrapped[(i+1)%n][0]*p[1],0);
    if(Math.abs(area)<1e-9)invalid('地区需要围成一个面积，不能只有一条直线');
    // D3 spherical polygons use clockwise outer rings for the bounded region.
    if(area>0)points.reverse();
  }
  const center=[unwrapped.reduce((s,p)=>s+p[0],0)/unwrapped.length,unwrapped.reduce((s,p)=>s+p[1],0)/unwrapped.length];center[0]=((center[0]+540)%360)-180;
  return {geometry:kind==='route'?{type:'LineString',coordinates:points}:{type:'Polygon',coordinates:[[...points,points[0].slice()]]},coordinates:center};
}
export function parseCoordinates(text){return String(text).split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(line=>{const parts=line.split(/[,，\s]+/);if(parts.length!==2||parts.some(x=>x===''))invalid('每行填写一组「经度, 纬度」');return point(parts.map(Number));});}
