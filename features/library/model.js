import {assert, DomainError, id} from '../../packages/contracts/index.js';

export const PROFILE='chronicle-reading-1';
export const MARKS={highlight:'高亮',underline:'下划线',rectangle:'方框',triangle:'三角形','filled-dot':'实心点','hollow-circle':'空心圈',circle:'大圆圈',cross:'叉号',check:'对号',slash:'斜杠'};
export const GLYPHS={triangle:'△','filled-dot':'●','hollow-circle':'○',cross:'×',check:'✓',slash:'／'};
export const canonicalText=value=>String(value??'').replace(/\r\n?/g,'\n').normalize('NFC');
export const cpSlice=(s,start,end)=>Array.from(s).slice(start,end).join('');
export const cpLength=s=>Array.from(s).length;
export function toCodePoint(text,offset){assert(Number.isInteger(offset)&&offset>=0&&offset<=text.length,'文字位置无效');assert(!(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset])),'不能切开 Unicode 字符');return cpLength(text.slice(0,offset));}
export function toUtf16(text,offset){assert(Number.isInteger(offset)&&offset>=0&&offset<=cpLength(text),'文字位置无效');return cpSlice(text,0,offset).length;}
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
function graphemeBoundary(text,offset){const u=toUtf16(text,offset);if(u===text.length)return true;for(const s of segmenter.segment(text)){if(s.index>=u)return s.index===u;}return false;}
export function quoteTarget(block,start,end){return{kind:'text',blockId:block.id,start,end,exact:cpSlice(block.text,start,end),prefix:cpSlice(block.text,Math.max(0,start-24),start),suffix:cpSlice(block.text,end,end+24)};}
export function normalizeBlock(block){
 const next={...block,id:block.id||id('block'),kind:block.kind||'paragraph',text:canonicalText(block.text),runs:block.runs||[],sourceRegions:block.sourceRegions||[],recognition:block.recognition||{method:'manual',status:'unreviewed',confidence:null}};
 if(!next.runs.length&&next.text)next.runs=[{text:next.text}];
 return next;
}
export function validateStructure(doc){
 assert(doc&&doc.profile===PROFILE&&typeof doc.renditionId==='string','阅读内容版本无效');
 assert(Array.isArray(doc.blocks)&&doc.blocks.length<=100000&&Array.isArray(doc.pages),'书籍结构无效');
 const ids=new Set();for(const b of doc.blocks){
  assert(typeof b.id==='string'&&b.id&&!ids.has(b.id),'书籍块身份重复或缺失');ids.add(b.id);
  assert(['heading','paragraph','list-item','formula','figure','table-cell','caption','footnote','code'].includes(b.kind),'不支持的内容块');
  assert(typeof b.text==='string'&&b.text===canonicalText(b.text)&&b.text.length<=1000000,'块文字不是规范文字');
  assert(Array.isArray(b.runs)&&b.runs.map(r=>r.atom?'\uFFFC':r.text||'').join('')===b.text,'显示内容与可选择文字不一致');
  for(const r of b.runs){assert(!r.atom||['formula','image'].includes(r.atom),'行内对象类型无效');if(r.atom==='formula')assert(typeof r.latex==='string'||typeof r.mathml==='string','公式缺少表示');}
  assert(b.pageIndex==null||Number.isInteger(b.pageIndex)&&b.pageIndex>=0&&b.pageIndex<doc.pages.length,'块所在页无效');
 }
 doc.pages.forEach((p,i)=>assert(p.index===i&&Number.isFinite(p.width)&&p.width>0&&Number.isFinite(p.height)&&p.height>0,'页尺寸或顺序无效'));
 return doc;
}
export function resolveTargets(doc,targets){
 assert(Array.isArray(targets)&&targets.length>0&&targets.length<=100,'请选择文字、公式、图片或页面区域');
 return targets.map(t=>{
  if(t.kind==='region'){
   assert(Number.isInteger(t.pageIndex)&&doc.pages[t.pageIndex],'原页不存在','TARGET_UNRESOLVED');
   assert(Array.isArray(t.rect)&&t.rect.length===4&&t.rect.every(Number.isFinite),'区域坐标无效');
   const[x,y,w,h]=t.rect;assert(x>=0&&y>=0&&w>0&&h>0&&x+w<=1.000001&&y+h<=1.000001,'区域超出原页');return{...t};
  }
  const block=doc.blocks.find(b=>b.id===t.blockId);assert(block,'选中段落不属于这个版本','TARGET_UNRESOLVED');
  if(t.kind==='object'){assert(['formula','figure'].includes(block.kind),'请选择一个公式或图片');return{kind:'object',blockId:block.id};}
  assert(t.kind==='text'&&Number.isInteger(t.start)&&Number.isInteger(t.end)&&t.start>=0&&t.end>t.start&&t.end<=cpLength(block.text),'文字范围无效','TARGET_UNRESOLVED');
  assert(graphemeBoundary(block.text,t.start)&&graphemeBoundary(block.text,t.end),'选择不能切开组合字符');
  const exact=quoteTarget(block,t.start,t.end);assert(t.exact===exact.exact,'选中文字与指定位置不一致','TARGET_UNRESOLVED');
  for(const k of ['prefix','suffix'])if(t[k]!==undefined)assert(t[k]===exact[k],'选区上下文不一致','TARGET_UNRESOLVED');
  if(t.regions){assert(Array.isArray(t.regions)&&t.regions.length<=100,'文字原页区域无效');for(const r of t.regions)resolveTargets(doc,[{kind:'region',...r}]);exact.regions=t.regions.map(r=>({pageIndex:r.pageIndex,rect:r.rect}));}
  return exact;
 });
}
export function validateMark(mark){
 assert(mark&&Object.hasOwn(MARKS,mark.type),'标记类型无效');
 assert(/^#[0-9a-f]{6}$/i.test(mark.color||''),'标记颜色无效');
 assert(mark.opacity===undefined||Number.isFinite(mark.opacity)&&mark.opacity>=0.05&&mark.opacity<=1,'透明度无效');
 return{type:mark.type,color:mark.color,opacity:mark.opacity??0.32};
}
export function blockText(block){return block.runs.map(r=>r.atom==='formula'?r.latex?`$${r.latex}$`:r.alt||'[MathML 公式]':r.atom==='image'?r.alt||'[图片]':r.text||'').join('');}
export function resourceUri(renditionId,blockId){return 'urn:chronicle:'+encodeURIComponent(renditionId)+':'+encodeURIComponent(blockId);}
export function exportAnnotation(object,doc){
 const a=object.data;
 return{...(a.exchange||{}),'@context':['http://www.w3.org/ns/anno.jsonld',{cr:{'@id':'urn:chronicle:reading:','@prefix':true}}],id:'urn:chronicle:'+object.id,type:'Annotation',created:object.createdAt,modified:object.updatedAt,motivation:a.body?'commenting':'highlighting',creator:{type:'Person',name:a.author||'本机读者'},body:{type:'TextualBody',format:'text/plain',language:'zh-CN',value:a.body||''},target:a.targets.map((t,index)=>{
  const base={type:'SpecificResource','cr:segmentIndex':index};
  if(t.kind==='region'){const[x,y,w,h]=t.rect;return{...base,source:resourceUri(a.renditionId,'page-'+t.pageIndex),selector:{type:'SvgSelector',value:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></svg>`}};}
  return{...base,source:resourceUri(a.renditionId,t.blockId),...(t.kind==='text'?{selector:[{type:'TextPositionSelector',start:t.start,end:t.end},{type:'TextQuoteSelector',exact:t.exact,prefix:t.prefix,suffix:t.suffix}]}:{})};
 }), 'cr:profile':PROFILE,'cr:publicationId':a.publicationId,'cr:renditionId':a.renditionId,'cr:revision':object.revision,'cr:mark':a.mark,'cr:targets':a.targets,'cr:deleted':!!object.deletedAt,'cr:recognition':a.targets.map(t=>doc.blocks.find(b=>b.id===t.blockId)?.recognition||null)};
}
export function reanchorTargets(oldDoc,newDoc,targets){
 return targets.map(t=>{
  if(t.kind!=='text')return{status:'unresolved',original:t,candidates:[]};
  const candidates=[];for(const b of newDoc.blocks){let at=0;while((at=b.text.indexOf(t.exact,at))>=0){const start=cpLength(b.text.slice(0,at));const q=quoteTarget(b,start,start+cpLength(t.exact));candidates.push(q);at+=Math.max(1,t.exact.length);}}
  const contextual=candidates.filter(c=>c.prefix.endsWith(t.prefix||'')&&c.suffix.startsWith(t.suffix||''));const matches=contextual.length?contextual:candidates;
  return{status:matches.length===1?'exact':matches.length?'ambiguous':'unresolved',original:t,candidates:matches};
 });
}
