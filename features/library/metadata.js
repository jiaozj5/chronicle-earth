// Conservative, local bibliographic extraction. Missing fields stay empty;
// software names and PDF creation dates are not authors or publication dates.
export const BOOK_FIELDS={title:'书名',author:'作者',subtitle:'副标题',publisher:'出版社',publishedDate:'出版日期',isbn:'ISBN',language:'语言'};
const clean=v=>String(v??'').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
const generic=/^(?:untitled|unknown|anonymous|无标题|未知|未命名(?:藏书)?|contents|table of contents|目录|前言|序言|版权页|封面)$/i;
const software=/^(?:Microsoft|Adobe|LaTeX|TeX|Word\b|Acrobat|PDFCreator|WPS\b|pandoc|xdvipdfmx)/i;
function isbn(value){const s=clean(value).replace(/^.*?ISBN(?:-1[03])?\s*[:：]?\s*/i,'').replace(/[-\s]/g,'').toUpperCase();if(/^\d{13}$/.test(s)&&[...s].reduce((n,c,i)=>n+Number(c)*(i%2?3:1),0)%10===0)return s;if(/^\d{9}[\dX]$/.test(s)&&[...s].reduce((n,c,i)=>n+(c==='X'?10:Number(c))*(10-i),0)%11===0)return s;return '';}
function valid(key,value){if(!value||value.length>500||generic.test(value)||software.test(value))return false;if(key==='title'&&(/\.(pdf|epub|txt|md)$/i.test(value)||/^https?:/i.test(value)))return false;return true;}
export function detectBookMetadata(doc,{embedded=doc.embeddedMetadata||{},filename=''}={}){
 const fields={};
 const set=(key,value,source,confidence,extra={})=>{value=clean(Array.isArray(value)?value.join('、'):value);if(key==='isbn')value=isbn(value);if(valid(key,value)&&!fields[key])fields[key]={value,source,confidence,...extra};};
 for(const key of Object.keys(BOOK_FIELDS))set(key,embedded[key],embedded.source||'file-metadata','high');
 const lines=doc.blocks.filter(b=>(b.pageIndex??0)<6&&!['code','formula','figure'].includes(b.kind)).flatMap(b=>b.text.split('\n').map(text=>({text:clean(text),pageIndex:b.pageIndex||0,blockId:b.id,kind:b.kind}))).filter(l=>l.text).slice(0,350);
 const patterns={title:/^(?:书名|正题名|title)\s*[:：]\s*(.+)$/i,author:/^(?:作者|著者|编著|主编|authors?|by)\s*(?:[:：]\s*|\s+)(.+)$/i,subtitle:/^(?:副标题|副题名|subtitle)\s*[:：]\s*(.+)$/i,publisher:/^(?:出版(?:社|者|单位)|publisher)\s*[:：]\s*(.+)$/i,publishedDate:/^(?:出版(?:日期|时间)|published(?:\s+(?:on|date))?)\s*[:：]\s*(.+)$/i,language:/^(?:语言|语种|language)\s*[:：]\s*(.+)$/i};
 for(const l of lines){for(const[key,re]of Object.entries(patterns)){const m=re.exec(l.text);if(m)set(key,m[1],'page-label','medium',{pageIndex:l.pageIndex,blockId:l.blockId});}const found=l.text.match(/ISBN(?:-1[03])?\s*[:：]?\s*([\dXx][\dXx -]{8,22})/i);if(found)set('isbn',found[1],'page-label','medium',{pageIndex:l.pageIndex,blockId:l.blockId});}
 const coverPage=lines[0]?.pageIndex,cover=lines.filter(l=>l.pageIndex===coverPage).slice(0,24);
 const possibleTitle=cover.find(l=>l.text.length>=2&&l.text.length<=120&&!generic.test(l.text)&&!/[。！？!?]/.test(l.text)&&!/^([\d\s.]+$|第.{1,8}章|ISBN|版权|copyright|©|作者|by\s|https?:|本书|\*|∗)/i.test(l.text)&&!Object.values(patterns).some(re=>re.test(l.text)));
 if(possibleTitle)set('title',possibleTitle.text,'cover-text','low',{pageIndex:possibleTitle.pageIndex,blockId:possibleTitle.blockId});
 const titleAt=cover.indexOf(possibleTitle),afterTitle=titleAt>=0?cover.slice(titleAt+1):cover;
 const sub=afterTitle[0];if(sub&&/^(?:或|又名|——|—\s|[:：])/.test(sub.text)&&sub.text.length<=120)set('subtitle',sub.text,'cover-text','low',{pageIndex:sub.pageIndex,blockId:sub.blockId});
 if(!fields.author){
  const names=[],origins=[],affiliation=/\b(?:University|College|Institute|UC\s|MIT\b|TTIC\b|Department|School of)\b|大学|学院|研究所/i;
  for(let i=0;i<afterTitle.length;i++){
   const l=afterTitle[i];if(/版权|copyright|©|本书|贡献|出版|ISBN/i.test(l.text))continue;
   const zh=/^([\p{L}·.\s、,，（）()【】\[\]-]{2,80}?)\s*(?:编著|主编|编写|著|编)$/u.exec(l.text);
   if(zh){set('author',zh[1],'cover-text','medium',{pageIndex:l.pageIndex,blockId:l.blockId});break;}
   const name=l.text.split(/[,，]/)[0].replace(/[∗*†‡\d]+$/g,'').trim();
   if(/^[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){1,4}$/u.test(name)&&!affiliation.test(name)&&(affiliation.test(l.text)||affiliation.test(afterTitle[i+1]?.text||'')||/[∗*†‡]$/.test(l.text))){names.push(name);origins.push(l.blockId);}
  }
  if(names.length)set('author',[...new Set(names)].join('、'),'cover-text','medium',{pageIndex:coverPage,blockIds:origins});
 }
 if(!fields.title){const fallback=clean(filename.replace(/\.(pdf|epub|txt|md|markdown|png|jpe?g|webp|tiff?)$/i,''));set('title',fallback,'filename','low');}
 return{version:1,detectedAt:new Date().toISOString(),fields};
}
export function metadataValues(data){return Object.fromEntries(Object.keys(BOOK_FIELDS).map(k=>[k,typeof data[k]==='string'?data[k]:'']));}
export function applyBookMetadata(data,detection){
 const overrides=data.metadataOverrides||Object.fromEntries(Object.keys(BOOK_FIELDS).filter(k=>data[k]&&(k!=='title'||data.title!==data.originalName)).map(k=>[k,true]));
 const next={...data,metadataOverrides:overrides,metadataDetection:detection};
 for(const[k,f]of Object.entries(detection.fields))if(!overrides[k])next[k]=f.value;
 return next;
}
export function editBookMetadata(data,input){const next={...data,metadataOverrides:{...(data.metadataOverrides||{})}};for(const k of Object.keys(BOOK_FIELDS))if(input[k]!==undefined){next[k]=clean(input[k]);next.metadataOverrides[k]=true;}return next;}
