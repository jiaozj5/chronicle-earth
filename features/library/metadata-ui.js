import {el,field} from '../../packages/ui/index.js';
import {BOOK_FIELDS} from './metadata.js';

export function metadataEditor(data,{prefix='书目',onChange=()=>{}}={}){
 const inputs={},root=el('div',{className:'book-metadata-fields'});
 for(const[key,label]of Object.entries(BOOK_FIELDS)){
  const input=el('input',{value:data[key]||'','aria-label':prefix+label,placeholder:'未识别，可手动填写',maxLength:500});inputs[key]=input;input.addEventListener('input',()=>onChange(key,input.value));
  const source=data.metadataDetection?.fields?.[key],manual=data.metadataOverrides?.[key];
  let hint=manual?'手动填写':source?source.source==='filename'?'来自文件名 · 待核对':source.source.endsWith('metadata')?'来自文件信息 · 请核对':`第 ${(source.pageIndex??0)+1} 页${source.source==='page-label'?'书目信息':'封面文字'} · 待核对`:'未识别';
  const wrapper=field(label,input);wrapper.append(el('small',{className:'muted'},hint));root.append(wrapper);
 }
 return{root,values:()=>Object.fromEntries(Object.entries(inputs).map(([k,input])=>[k,input.value]))};
}
