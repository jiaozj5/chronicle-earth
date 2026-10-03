import {el,button} from '../../packages/ui/index.js';
import {mount as mountConverter} from '../converter/index.js';

// Library owns the viewport; converter owns its upload and task lifecycle.
export async function mount(container,ctx){
 if(!document.querySelector('link[data-feature="converter"]'))document.head.append(el('link',{rel:'stylesheet',href:'/features/converter/style.css','data-feature':'converter'}));
 document.body.classList.add('library-space');
 const root=el('div',{className:'lib-root','data-mode':'convert'}),host=el('section',{'aria-label':'藏书格式转换'});
 const header=el('div',{className:'lib-welcome'},el('div',{},el('span',{className:'lib-eyebrow'},'MY PRIVATE LIBRARY'),el('h2',{},'材料藏书'),el('p',{},'转换材料，核对后放入书架。')),el('div',{className:'row'},button('← 回到工作空间',()=>ctx.navigate('chronicle'),'button ghost'),button('返回书架',()=>ctx.navigate('library'),'button ghost'),el('span',{className:'lib-section-current','aria-current':'page'},'格式转换')));
 root.append(header,host);container.replaceChildren(root);
 let converter;
 try{converter=await mountConverter(host,ctx);}catch(error){document.body.classList.remove('library-space');throw error;}
 return{dispose(){converter.dispose();document.body.classList.remove('library-space');},getNavigationState(){return{section:'convert',...converter.getNavigationState()};},refresh:()=>converter.refresh()};
}
