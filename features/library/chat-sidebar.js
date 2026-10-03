import {el,button,renderMarkdown} from '../../packages/ui/index.js';
import {id} from '../../packages/contracts/index.js';
import {readingModelPicker} from './model-picker.js';

export function companionSidebar({publicationId,api,getContext,jumpTo,connect,notify}){
 const draftKey='library-companion-question:'+publicationId,threadKey='library-companion-thread:'+publicationId,pendingKey='library-companion-pending:'+publicationId;
 let threadId=localStorage.getItem(threadKey),messages=[],threads=[],busy=false,disposed=false,controller=null,frame=null,poll=null,latest=null;
 const messageBodies=new Map();let pending=null;try{pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');if(pending)threadId=pending.threadId;}catch{}
 const connection=button('正在连接 Codex…',()=>checkConnection(true),'lib-chat-connection'),status=el('p',{className:'lib-companion-status',role:'status'});
 const context=el('span',{className:'lib-companion-position'}),quote=el('blockquote',{className:'lib-companion-quote',hidden:true});
 const log=el('div',{className:'lib-chat-log',role:'log','aria-label':'伴读对话','aria-live':'polite','aria-relevant':'additions text',tabIndex:0});
 const input=el('textarea',{rows:2,'aria-label':'伴读问题',placeholder:'问问这段内容，或继续追问…',value:sessionStorage.getItem(draftKey)||'',maxLength:16000});
 input.oninput=()=>{sessionStorage.setItem(draftKey,input.value);controls();};
 input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!busy)send();}});
 const image=el('input',{type:'checkbox',checked:true,'aria-label':'附上当前页图'});
 const sendButton=button('发送 ↑',()=>send(),'button primary'),stop=button('停止生成',()=>stopReply(),'button ghost'),recover=button('恢复上次发送',()=>send(null,pending),'button ghost');
 const newChat=button('＋',()=>{if(busy)return;threadId=id('reading_chat');localStorage.setItem(threadKey,threadId);messages=[];pending=null;sessionStorage.removeItem(pendingKey);status.textContent='新的对话';historyOptions();paint();controls();input.focus();},'button ghost');newChat.setAttribute('aria-label','新建伴读对话');newChat.title='新对话';
 const history=el('select',{'aria-label':'伴读对话记录',className:'lib-chat-history'});history.onchange=async()=>{if(busy)return;threadId=history.value;localStorage.setItem(threadKey,threadId);await loadHistory();};
 const quick=el('div',{className:'lib-companion-quick'});for(const[label,text]of [['解释','请解释选中的内容；没有选区时解释当前页。'],['公式','请解释这一处公式的符号、假设和推导。'],['提问','根据当前页提出一个检查我是否理解的问题。']])quick.append(button(label,()=>{input.value=text;input.dispatchEvent(new Event('input'));input.focus();},'button ghost'));
 const picker=readingModelPicker({api,notify,onChange:()=>{image.disabled=!picker.vision();if(image.disabled)image.checked=false;checkConnection();}});
 const root=el('section',{className:'lib-companion lib-chat','aria-label':'AI 伴读'},
  el('header',{},el('h3',{},'AI 伴读'),el('div',{className:'lib-chat-actions'},button('接口',connect,'button ghost'),newChat)),connection,history,log,
  el('div',{className:'lib-chat-composer'},el('div',{className:'lib-chat-context'},context),quote,quick,input,picker.root,status,recover,
   el('div',{className:'lib-chat-send-row'},el('label',{},image,'附上当前页图'),stop,sendButton),el('small',{className:'lib-chat-hint'},'Enter 发送 · Shift＋Enter 换行')));
 function controls(){sendButton.disabled=busy||!input.value.trim()||!latest;sendButton.hidden=busy;stop.hidden=!busy;newChat.disabled=history.disabled=busy;recover.hidden=!pending||busy;picker.setBusy(busy);}
 function schedulePaint(messageId){if(frame===null)frame=requestAnimationFrame(()=>{frame=null;if(disposed)return;const m=messages.find(m=>m.id===messageId),content=messageBodies.get(messageId);if(!m||!content)return;const nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<65;content.replaceChildren(m.data.body?renderMarkdown(m.data.body):el('p',{className:'lib-chat-thinking'},'正在思考…'));if(nearBottom)log.scrollTop=log.scrollHeight;});}
 function paint(forceBottom=false){
  const nearBottom=forceBottom||log.scrollHeight-log.scrollTop-log.clientHeight<65;log.replaceChildren();messageBodies.clear();
  if(!messages.length)log.append(el('div',{className:'lib-chat-empty'},el('span',{},'与这本书聊一聊'),el('p',{},'选中一句话，问它的含义。也可以直接提问，我会结合当前页回答。')));
  for(const m of messages){const d=m.data,assistant=d.role==='assistant',article=el('article',{className:'lib-chat-message '+(assistant?'assistant':'user'),dataset:{messageId:m.id}});
   article.append(el('div',{className:'lib-chat-role'},assistant?(d.modelLabel||d.model||(d.provider==='doubao'?'豆包':'Codex')):'你'));
   if(!assistant&&d.context)article.append(button('第 '+(d.context.pageIndex+1)+' 页 · '+(d.context.targets.length?'选区':'当前页'),()=>jumpTo(d.context),'lib-chat-source'));
   const content=el('div',{},d.body?renderMarkdown(d.body):el('p',{className:'lib-chat-thinking'},d.pending?'正在思考…':'尚未收到回答'));messageBodies.set(m.id,content);article.append(content);
   if(d.actions?.length){const trace=el('details',{className:'lib-chat-tools'},el('summary',{},'操作记录 · '+d.actions.length+' 项'));for(const a of d.actions)trace.append(el('div',{},el('span',{},(a.status==='complete'?'✓ ':a.status==='failed'?'✕ ':'… ')+a.label),el('small',{},a.status==='failed'?a.error:a.status==='running'?(d.pending?'执行中':'生成已中断，请核对操作结果'):'已完成'),a.arguments?.body?el('p',{},a.arguments.body.slice(0,160)):Number.isInteger(a.arguments?.pageIndex)?el('small',{},'第 '+(a.arguments.pageIndex+1)+' 页'):null,el('details',{},el('summary',{},'参数与回执'),el('pre',{},JSON.stringify({arguments:a.arguments,...(a.result?{result:a.result}:{})},null,2)))));article.append(trace);}
   if(assistant&&!d.pending){const actions=el('div',{className:'lib-chat-message-actions'});if(d.body)actions.append(button('复制',()=>navigator.clipboard.writeText(d.body).catch(e=>notify(e.message,'error')),'button ghost'));if(d.status!=='complete'){article.append(el('p',{className:'lib-chat-error'},d.error?.message||'生成已中断'));actions.append(button('重试回答',()=>send(m),'button ghost'));}article.append(actions);}log.append(article);
  }if(nearBottom)log.scrollTop=log.scrollHeight;
 }
 function historyOptions(){history.replaceChildren(el('option',{value:threadId||''},threads.find(t=>t.id===threadId)?.title||'当前对话'),...threads.filter(t=>t.id!==threadId).map(t=>el('option',{value:t.id},t.title)));history.value=threadId||'';history.hidden=threads.length<2&&!threads.some(t=>t.id!==threadId);}
 async function checkConnection(refresh=false){const provider=picker.selection().provider;connection.disabled=true;try{const r=await api.readingChat('status',{refresh,provider});if(disposed||provider!==picker.selection().provider)return;connection.textContent=r.connected?(provider==='doubao'?'● 豆包已配置':'● Codex 已连接'):'○ '+picker.label()+' 未连接';connection.dataset.connected=String(r.connected);connection.title=r.message;if(!r.connected)status.textContent=r.message;else if(!busy)status.textContent='';}catch(e){if(!disposed){connection.textContent='○ 重新连接 '+picker.label();status.textContent=e.message;}}finally{connection.disabled=false;}}
 async function loadHistory(){const requestedThread=threadId;try{const result=await api.readingChat('history',{publicationId,...(threadId?{threadId}:{})});if(disposed||requestedThread!==threadId||controller)return;threadId=result.threadId||threadId||id('reading_chat');localStorage.setItem(threadKey,threadId);messages=result.messages;threads=result.threads;if(pending&&messages.some(m=>m.id==='reading_reply_'+pending.requestId&&!m.data.pending)){pending=null;sessionStorage.removeItem(pendingKey);}historyOptions();paint(true);clearTimeout(poll);if(result.running){busy=true;status.textContent='模型正在回答…';poll=setTimeout(loadHistory,1500);}else busy=false;controls();}catch(e){if(!disposed&&requestedThread===threadId)status.textContent=e.message;}}
 async function stopReply(){status.textContent='正在停止…';try{await api.readingChat('cancel',{publicationId,threadId});}catch{controller?.abort();}}
 async function send(retry=null,resume=null){
  if(busy||disposed||!latest)return;if(!resume&&!retry&&!input.value.trim())return;
  const original=input.value;let payload=resume;
  if(!payload){const ctx=getContext();payload={...ctx,...picker.selection(),publicationId,threadId:threadId||id('reading_chat'),requestId:id('chat_request'),body:retry?messages.find(m=>m.id===retry.data.questionId)?.data.body||'请重试上次回答':original.trim(),includeImage:image.checked,...(retry?{retryOf:retry.id}:{})};}
  threadId=payload.threadId;localStorage.setItem(threadKey,threadId);pending=payload;sessionStorage.setItem(pendingKey,JSON.stringify(payload));busy=true;controller=new AbortController();controls();status.textContent='正在发送…';
  try{await api.streamReadingChat(payload,{signal:controller.signal,onEvent:event=>{
   if(disposed)return;
   if(event.type==='started'){for(const m of [event.question,event.message]){const index=messages.findIndex(x=>x.id===m.id);if(index>=0)messages[index]=m;else messages.push(m);}if(!retry&&input.value===original){input.value='';sessionStorage.removeItem(draftKey);}paint(true);}
   else if(event.type==='text'){const m=messages.find(m=>m.id==='reading_reply_'+payload.requestId);if(m){m.data.body=event.text;schedulePaint(m.id);}status.textContent='正在回答…';}
   else if(event.type==='status')status.textContent=event.text;
   else if(event.type==='action'){const m=messages.find(m=>m.id===event.messageId);if(m){const actions=m.data.actions||=[];const index=actions.findIndex(a=>a.id===event.action.id);if(index<0)actions.push(event.action);else actions[index]=event.action;paint();}status.textContent=event.action.label+(event.action.status==='complete'?' · 已完成':event.action.status==='failed'?' · 未完成':'…');}
   else if(event.type==='done'){const index=messages.findIndex(m=>m.id===event.message.id);if(index>=0)messages[index]=event.message;else messages.push(event.message);pending=null;sessionStorage.removeItem(pendingKey);status.textContent=event.error?.message||'';paint();}
  }});}catch(e){if(!disposed){status.textContent=e.message;if(e.code!=='SERVICE_UNAVAILABLE'&&e.code!=='CANCELLED'&&e.name!=='TypeError'){pending=null;sessionStorage.removeItem(pendingKey);}}}
  finally{controller=null;busy=false;if(!disposed){controls();await loadHistory();}}
 }
 controls();checkConnection();loadHistory();
 return{root,update({pageIndex,targets,selection}){latest={pageIndex,targets};context.textContent='第 '+(pageIndex+1)+' 页 · '+(targets.length?'已选中 '+targets.length+' 处':'当前页');quote.hidden=!targets.length;quote.textContent=selection?selection.slice(0,240):targets.length?'已选择原页区域':'';controls();},dispose(){disposed=true;picker.dispose();controller?.abort();clearTimeout(poll);if(frame!==null)cancelAnimationFrame(frame);}};
}
