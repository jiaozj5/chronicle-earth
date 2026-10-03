/** The application's only occurrence-time parser and day-range implementation. */
import {DomainError} from '../../packages/contracts/index.js';
export const INDEX_YEARS = {min: -9999, max: 10000};
const DAY = 86400000;
const base = originalText => ({originalText, calendar:'proleptic-gregorian',kind:'unknown',precision:'year',approximate:false,earliest:null,latest:null});
function astro(bound){return bound.era === 'BCE' ? 1-bound.year : bound.year;}
function boundForYear(year){return {era:year<=0?'BCE':'CE',year:year<=0?1-year:year};}
function days(year,month=1,day=1){const d=new Date(0);d.setUTCFullYear(year,month-1,day);d.setUTCHours(0,0,0,0);return Math.floor(d.getTime()/DAY);}
function validBound(bound){
  if(!bound || !['CE','BCE'].includes(bound.era)||!Number.isInteger(bound.year)||bound.year<1)return false;
  const m=bound.month??1, d=bound.day??1;
  if(!Number.isInteger(m)||m<1||m>12||!Number.isInteger(d)||d<1||d>31 || (bound.day != null && bound.month == null))return false;
  const dt=new Date(days(astro(bound),m,d)*DAY);
  return dt.getUTCFullYear()===astro(bound)&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d;
}
function parseBound(text,inheritedEra){
  const s=text.trim().replace(/\s+/g,'');
  const m=s.match(/^(?:(公元前|公元|BCE|BC|CE|AD)\s*)?(\d{1,6})(?:年(?:(\d{1,2})月(?:(\d{1,2})日?)?)?|[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/i);
  if(!m)return null;
  const era=/^(公元前|BCE|BC)$/i.test(m[1]||'')?'BCE':m[1]?'CE':inheritedEra||'CE';
  const b={era,year:Number(m[2])};
  if(m[3]||m[5])b.month=Number(m[3]||m[5]);if(m[4]||m[6])b.day=Number(m[4]||m[6]);
  if(!validBound(b))throw new DomainError('INVALID_INPUT','日期无效，请检查年份、月份和日期；纪年没有公元0年。',{field:'occurrenceTime',reason:'INVALID_TIME',originalText:text});
  return b;
}
const precisionOf = b=>b?.day?'day':b?.month?'month':'year';
function spec(originalText,earliest,latest,kind='instant',approximate=false){return {...base(originalText),kind,precision:precisionOf(earliest||latest),approximate,earliest,latest};}
function shiftUnit(b,delta){
  if(b.day){const date=new Date((days(astro(b),b.month,b.day)+delta)*DAY);return {...boundForYear(date.getUTCFullYear()),month:date.getUTCMonth()+1,day:date.getUTCDate()};}
  if(b.month){const date=new Date(days(astro(b),b.month+delta,1)*DAY);return {...boundForYear(date.getUTCFullYear()),month:date.getUTCMonth()+1};}
  return boundForYear(astro(b)+delta);
}
export function parseTime(value){
  if(value&&typeof value==='object')return value;
  const originalText=String(value??'').trim();
  if(!originalText)return base('');
  let text=originalText.replace(/\s+/g,'').replace(/[～~]/g,'至');
  const approximate=/约|大约|大致/.test(text);text=text.replace(/大约|大致|约/g,'');
  // "前后" has no supplied bounds: retain the words without inventing a window.
  if(/前后/.test(text))return {...base(originalText),approximate:true};
  let m=text.match(/^(?:从|自)(.+?)(?:起|开始|以后)$/);
  if(m){const b=parseBound(m[1]);return b?spec(originalText,b,null,'duration',approximate):base(originalText);}
  m=text.match(/^(?:截至|截止|到)(.+?)(?:为止)?$/);
  if(m){const b=parseBound(m[1]);return b?spec(originalText,null,b,'duration',approximate):base(originalText);}
  m=text.match(/^(.+?)(以后|之后|以前|之前|及以后|及以前|起)$/);
  if(m){const b=parseBound(m[1]);if(!b)return base(originalText);const after=/后|起/.test(m[2]);const inclusive=/及|起/.test(m[2]);return spec(originalText,after?(inclusive?b:shiftUnit(b,1)):null,after?null:(inclusive?b:shiftUnit(b,-1)),'duration',approximate);}
  const uncertain=/之间|不确定|不详|某时/.test(text);text=text.replace(/之间|不确定|不详|某时|持续|期间|发生|在/g,'');
  let pieces=text.split(/至|—|–|\.\./);
  if(pieces.length===1&&/^\d{1,6}\s*-\s*\d{3,6}年?$/.test(text))pieces=text.split('-');
  if(pieces.length===2){const first=parseBound(pieces[0]);const second=parseBound(pieces[1],first?.era);if(first&&second)return spec(originalText,first,second,uncertain?'uncertain':'duration',approximate);return base(originalText);}
  const b=parseBound(text);return b?spec(originalText,b,b,'instant',approximate):base(originalText);
}
export function toRange(value){
  const s=typeof value==='string'?parseTime(value):value;
  if(!s||s.kind==='unknown'||(!s.earliest&&!s.latest))return {startDay:null,endDayExclusive:null,indexed:false,reason:'时间尚未确定'};
  if(s.calendar&&s.calendar!=='proleptic-gregorian')return {startDay:null,endDayExclusive:null,indexed:false,reason:'此历法暂未换算，保留原文'};
  for(const b of [s.earliest,s.latest].filter(Boolean)){
    if(!validBound(b))return {startDay:null,endDayExclusive:null,indexed:false,reason:'日期无效'};
    if(astro(b)<INDEX_YEARS.min||astro(b)>INDEX_YEARS.max)return {startDay:null,endDayExclusive:null,indexed:false,reason:'超出公元前10000年至公元10000年的索引范围'};
  }
  const a=s.earliest,b=s.latest;
  const startDay=a?days(astro(a),a.month??1,a.day??1):-Infinity;
  const endDayExclusive=!b?Infinity:b.day?days(astro(b),b.month,b.day)+1:b.month?days(astro(b),b.month+1,1):days(astro(b)+1,1,1);
  if(startDay>=endDayExclusive)return {startDay,endDayExclusive,indexed:false,reason:'开始时间晚于结束时间'};
  return {startDay,endDayExclusive,indexed:true};
}
export function overlaps(a,b){const x=a?.indexed!==undefined?a:toRange(a),y=b?.indexed!==undefined?b:toRange(b);return x.indexed&&y.indexed&&x.startDay<y.endDayExclusive&&y.startDay<x.endDayExclusive;}
// Time-view edits use this same calendar implementation; no parallel date parser.
export function rangeToTimeSpec(startDay,endDayExclusive){
  if(!(startDay<endDayExclusive)||(!Number.isInteger(startDay)&&startDay!==-Infinity)||(!Number.isInteger(endDayExclusive)&&endDayExclusive!==Infinity))throw new DomainError('INVALID_INPUT','时间范围无效');
  const fromDay=value=>{const d=new Date(value*DAY);return {...boundForYear(d.getUTCFullYear()),month:d.getUTCMonth()+1,day:d.getUTCDate()};};
  const result=spec('',startDay===-Infinity?null:fromDay(startDay),endDayExclusive===Infinity?null:fromDay(endDayExclusive-1),'duration');
  if(!result.earliest&&!result.latest)throw new DomainError('INVALID_INPUT','请保留至少一个时间边界');
  if(!toRange(result).indexed)throw new DomainError('INVALID_INPUT','时间范围超出索引边界');
  result.originalText=!result.earliest?`截至${fmt(result.latest)}`:!result.latest?`从${fmt(result.earliest)}起`:`${fmt(result.earliest)}—${fmt(result.latest)}`;
  return result;
}
function fmt(b){if(!b)return '';return `${b.era==='BCE'?'公元前':''}${b.year}年${b.month?b.month+'月':''}${b.day?b.day+'日':''}`;}
export function formatTime(value){
  const s=typeof value==='string'?parseTime(value):value;if(!s)return '时间不详';
  const range=toRange(s);if(!range.indexed)return s.originalText||'时间不详';
  let str=!s.earliest?`截至${fmt(s.latest)}`:!s.latest?`从${fmt(s.earliest)}起`:s.kind==='instant'?fmt(s.earliest):`${fmt(s.earliest)}—${fmt(s.latest)}${s.kind==='uncertain'?'之间（具体时间不确定）':'（持续期间）'}`;
  return (s.approximate?'约 ':'')+str;
}
