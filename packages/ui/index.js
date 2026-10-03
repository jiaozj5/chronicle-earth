import {marked} from './vendor/marked/lib/marked.esm.js';
import DOMPurify from './vendor/dompurify/dist/purify.es.mjs';

export function el(tag,attrs={},...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attrs||{})){
  if(value===undefined||value===null)continue;
  if(key.startsWith('aria-')){node.setAttribute(key,String(value));continue;}
  if(value===false)continue;
  if(key==='className'||key==='class')node.className=value;
  else if(key==='text')node.textContent=value;
  else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2).toLowerCase(),value);
  else if(key==='dataset')Object.assign(node.dataset,value);
  else if(key==='style'&&typeof value==='object')Object.assign(node.style,value);
  else if(key==='value')node.value=value;
  else if(key==='checked')node.checked=!!value;
  else node.setAttribute(key,value===true?'':String(value));
 }
 for(const child of children.flat(Infinity))if(child!==null&&child!==undefined&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));
 return node;
}
export function button(label,onClick,className='button'){return el('button',{type:'button',className,onClick},label);}
export function field(label,input){return el('label',{className:'field'},el('span',{className:'field-label'},label),input);}
export function formatDate(value){if(!value)return'';try{return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}catch{return String(value);}}
export function renderMarkdown(body=''){
 const node=el('div',{className:'prose'});
 const html=marked.parse(String(body),{gfm:true,breaks:true});
 node.innerHTML=DOMPurify.sanitize(html,{USE_PROFILES:{html:true},FORBID_TAGS:['style','form','input','button','iframe','video','audio'],FORBID_ATTR:['style']});
 node.querySelectorAll('a').forEach(a=>{const href=a.getAttribute('href')||'';if(!/^(https?:\/\/|\/api\/attachments\/|#)/i.test(href)){a.removeAttribute('href');return;}a.target='_blank';a.rel='noopener noreferrer';});
 node.querySelectorAll('img').forEach(img=>{if(!/^\/api\/attachments\/[A-Za-z0-9_.-]+$/.test(img.getAttribute('src')||'')){const label=el('span',{className:'muted'},'[图片：'+(img.alt||'外部图片')+']');img.replaceWith(label);}else img.loading='lazy';});
 node.querySelectorAll('table').forEach(table=>{const wrap=el('div',{className:'table-scroll'});table.replaceWith(wrap);wrap.append(table);});
 if(globalThis.renderMathInElement)globalThis.renderMathInElement(node,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'$',right:'$',display:false},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false,strict:'warn'});
 return node;
}
export function emptyState(title,detail,action){return el('div',{className:'empty-state'},el('div',{className:'empty-symbol','aria-hidden':true},'◌'),el('h2',{},title),el('p',{className:'muted'},detail),action);}
export function errorText(error){return error?.message||'操作未完成，请保留内容后重试。';}
