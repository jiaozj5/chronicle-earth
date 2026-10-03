import test from 'node:test';
import assert from 'node:assert/strict';
import {createDoubaoProvider} from './doubao-provider.js';
const settings={endpoint:'https://ark.cn-beijing.volces.com/api/v3',apiKey:'test-ark-key'};
function stream(events){const text=events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\r\n\r\n').join(''),bytes=new TextEncoder().encode(text);return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
const chunk=(delta,finish_reason=null)=>({choices:[{delta,finish_reason}]});
test('Doubao streams split UTF-8 and tool arguments, supplies real tool results, and continues to a final answer',async()=>{
 const requests=[],actions=[],texts=[];const provider=createDoubaoProvider({fetchImpl:async(url,o)=>{assert.equal(url,settings.endpoint+'/chat/completions');assert.equal(o.headers.Authorization,'Bearer test-ark-key');assert.equal(o.redirect,'error');requests.push(JSON.parse(o.body));return requests.length===1?stream([chunk({tool_calls:[{index:0,id:'call_1',function:{name:'book_search',arguments:'{"query":'}}]}),chunk({tool_calls:[{index:0,function:{arguments:'"慢读"}'}}]},'tool_calls'),'[DONE]']):stream([chunk({content:'找到了'}),chunk({content:'慢读。'},'stop'),'[DONE]']);}});
 const result=await provider.generate({settings,model:'ep-custom',instructions:'伴读',prompt:'搜索慢读',tools:[{name:'book_search',description:'搜索',inputSchema:{type:'object'}}],callTool:async(name,args,id)=>{actions.push({name,args,id});return{success:true,result:{page:3}};},onText:t=>texts.push(t)});
 assert.equal(result.body,'找到了慢读。');assert.deepEqual(actions,[{name:'book_search',args:{query:'慢读'},id:'call_1'}]);assert.equal(requests[1].messages.at(-1).role,'tool');assert.match(requests[1].messages.at(-1).content,/"page":3/);assert.equal(requests[0].model,'ep-custom');assert.equal(texts.at(-1),result.body);
});
test('Doubao truncated streams preserve partial text and authentication errors never expose server bodies',async()=>{
 const received=[];const p=createDoubaoProvider({fetchImpl:async()=>stream([chunk({content:'半句话'})])});await assert.rejects(p.generate({settings,model:'ep-test',instructions:'',prompt:'test',onText:t=>received.push(t)}),e=>e.code==='PROVIDER_UNAVAILABLE');assert.equal(received[0],'半句话');
 const auth=createDoubaoProvider({fetchImpl:async()=>new Response('secret body',{status:401})});await assert.rejects(auth.generate({settings,model:'ep-test',instructions:'',prompt:'test'}),e=>e.code==='PROVIDER_AUTH'&&!e.message.includes('secret'));
});
test('Doubao cancellation aborts the active provider request',async()=>{const c=new AbortController();const p=createDoubaoProvider({fetchImpl:async(u,o)=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});queueMicrotask(()=>c.abort());})});await assert.rejects(p.generate({settings,model:'ep-test',instructions:'',prompt:'test',signal:c.signal}),e=>e.code==='CANCELLED');});
