import {el,button} from '../../packages/ui/index.js';

export function outlineView(outline,onSelect){
 const headings=outline?.headings||[],pages=outline?.pages||[],fallback=!headings.length;
 const entries=fallback?pages.filter((p,i)=>i%20===0).map(p=>({id:'page-'+p.index,title:'第 '+(p.index+1)+(Math.min(p.index+20,pages.length)>p.index+1?'—'+Math.min(p.index+20,pages.length):'')+' 页',pageIndex:p.index,level:1})):headings;
 const root=el('nav',{className:'lib-outline','aria-label':'书内目录'}),items=[];
 root.append(el('p',{className:'lib-outline-source'},outline?.outlineWarning||(fallback?'原书没有章节目录 · 按页浏览':(outline?.outlineSource==='pdf-bookmarks'?'原书书签':'内容标题')+' · '+headings.length+' 项')));
 let index=0;
 function branch(level){const list=el('ul');while(index<entries.length&&entries[index].level>=level){const h=entries[index++],li=el('li'),b=button('',()=>onSelect(h.pageIndex,fallback?null:h.id),'lib-outline-link');b.append(el('span',{},h.title),el('small',{},String(h.pageIndex+1)));b.setAttribute('aria-label',h.title+'，第 '+(h.pageIndex+1)+' 页');items.push({h,b});if(index<entries.length&&entries[index].level>h.level){const details=el('details',{},el('summary',{},b),branch(entries[index].level));b.addEventListener('click',e=>e.preventDefault());li.append(details);}else li.append(b);list.append(li);}return list;}
 if(entries.length)root.append(branch(Math.min(...entries.map(h=>h.level))));
 return{root,update(pageIndex){let active=null;for(const item of items)if(item.h.pageIndex<=pageIndex&&(!active||item.h.pageIndex>=active.h.pageIndex))active=item;for(const item of items){if(item===active)item.b.setAttribute('aria-current','location');else item.b.removeAttribute('aria-current');}for(let n=active?.b.parentElement;n&&n!==root;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;}};
}
