import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {testServer,environment,writeReport,browserEngine,digest,snapshot,poll} from '../fixtures/harness.mjs';
import {createChange,changeFor,refOf} from '../../packages/contracts/index.js';
import {parseTime} from '../../features/atlas/time.js';
import {prepareEntryChange} from '../../features/chronicle/service.js';
import {validateCitation,referenceStatus} from '../../features/knowledge/service.js';

const report={suite:'Independent acceptance: real SQLite, loopback HTTP, Edge UI',environment:await environment(),cases:[],realModel:'Not configured by user choice; protocol stub does not verify A07',realUsers:'Not performed; G5 remains unverified'};
const {app,base,token,request,output}=await testServer('acceptance');report.output=output;
let provider,browser;let count=0;
const next=label=>'qa_'+label+'_'+(++count);
const run=async(id,name,fn)=>{const start=performance.now();try{const evidence=await fn();report.cases.push({id,name,status:'passed',durationMs:+(performance.now()-start).toFixed(1),evidence:evidence??null});console.log('PASS '+id+' '+name);}catch(error){report.cases.push({id,name,status:'failed',durationMs:+(performance.now()-start).toFixed(1),error:error.stack});console.error('FAIL '+id+' '+name+' '+error.message);}};
const commit=changes=>request('/api/commit',{requestId:next('commit'),changes});
const get=(id,options='')=>request('/api/objects/'+id+options);
const entry=(body,extra={})=>({title:'',body,kind:'note',status:'adopted',occurrenceTime:null,placeRefs:[],citations:[],...extra});
const places=app.workspace.list({objectType:'place',limit:2}).items;
const located=entry('同一记录关注两个地方',{occurrenceTime:parseTime('1850—1860'),placeRefs:places.map(p=>({placeId:p.id,confirmed:true,originalName:p.data.name}))});
let locatedObject,prediction,source,knowledge,message,discussion,adoption;
const secret='qa-sensitive-key-'+Date.now(),privateText='PRIVATE_CONTENT_MUST_NEVER_REACH_PROVIDER';
try{
 await run('HTTP01','本机来源与会话令牌保护',async()=>{
  assert.equal((await fetch(base+'/api/commit',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{'X-Chronicle-Token':token,Origin:'http://external.invalid'},body:'{}'})).status,400);
  assert.equal((await fetch(base+'/.local/settings.json')).status,404);
 });
 await run('R02','无时间地点也可保存与中文正文检索',async()=>{
  const result=await commit([prepareEntryChange(entry('无地理归属也要保留我的个人理解，青瓷钟声。'))]);
  const saved=await get(result.objects[0].id);assert.equal(saved.data.placeRefs.length,0);
  const found=await request('/api/objects?objectType=entry&q='+encodeURIComponent('青瓷钟声'));assert.equal(found.total,1);assert.equal(found.items[0].id,saved.id);
  assert.equal((await request('/api/atlas')).total,0);
 });
 await run('C01_C05','多地点去重、筛选不改变探索',async()=>{
  locatedObject=(await commit([prepareEntryChange(located,null,'qa_located')])).objects[0];
  const map=await request('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime('1855'))));
  assert.equal(map.total,1);assert.equal(map.markers.length,2);assert.equal(map.explored.length,2);assert(map.markers.every(m=>m.recordCount===1));
  const hidden=await request('/api/atlas?q=absent-query-778899');assert.equal(hidden.visibleTotal,0);assert.equal(hidden.explored.length,2);
 });
 await run('C03_C04','迁移时空、删除最后记录及恢复一致',async()=>{
  locatedObject=(await commit([prepareEntryChange({...locatedObject.data,occurrenceTime:parseTime('1865'),placeRefs:[locatedObject.data.placeRefs[0]]},locatedObject)])).objects[0];
  assert.equal((await request('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime('1855'))))).total,0);
  assert.equal((await request('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime('1865'))))).total,1);
  locatedObject=(await commit([{...changeFor(locatedObject,locatedObject.data),deleted:true}])).objects[0];assert.equal((await request('/api/atlas')).total,0);
  locatedObject=(await commit([{...changeFor(locatedObject,locatedObject.data),deleted:false}])).objects[0];assert.equal((await request('/api/atlas')).total,1);assert.equal(locatedObject.id,'qa_located');
 });
 await run('C06','相同提交重放三次且不允许异载荷复用',async()=>{
  const body={requestId:next('idempotence'),changes:[prepareEntryChange(entry('幂等测试'))]};const first=await request('/api/commit',body);
  for(let i=0;i<3;i++)assert.deepEqual(await request('/api/commit',body),first);
  const conflict=await request('/api/commit',{...body,changes:[{...body.changes[0],data:entry('不同内容')}]},409);assert.equal(conflict.error.code,'IDEMPOTENCY_CONFLICT');
 });
 await run('R08','预言原始版本和用户修订均保留',async()=>{
  prediction=(await commit([prepareEntryChange(entry('2050 年的一个个人预言',{kind:'prediction',occurrenceTime:parseTime('2050')}),null,'qa_prediction')])).objects[0];
  prediction=(await commit([prepareEntryChange({...prediction.data,occurrenceTime:parseTime('1900'),body:'修改目标时间后仍是预言'},prediction)])).objects[0];
  assert.equal(prediction.data.kind,'prediction');assert.equal(prediction.data.initialPredictionRevision,1);assert.equal((await get(prediction.id,'?revision=1')).data.body,'2050 年的一个个人预言');
 });
 await run('HTTP02','服务端拒绝改变预言身份和无效记录',async()=>{
  const response=await request('/api/commit',{requestId:next('invalid'),changes:[changeFor(prediction,{...prediction.data,kind:'note'})]},400);assert.equal(response.error.code,'INVALID_INPUT');
  await request('/api/commit',{requestId:next('empty'),changes:[createChange('entry',entry(''))]},400);
 });
 await run('C08_K04','固定来源片段保持原版本，删除不丢失依赖',async()=>{
  source=(await commit([createChange('source',{title:'验收材料',body:'河流与城市相互影响。知识需要留下证据。',format:'text',parseStatus:'ready',attachmentIds:[],citations:[]},'qa_source')])).objects[0];
  const ref={...refOf(source),locator:{start:0,end:11},quote:source.data.body.slice(0,11)};
  knowledge=(await commit([createChange('knowledge',{title:'我的观点',body:'这是用户自己的理解，可以与资料矛盾。',kind:'claim',citations:[ref]},'qa_claim')])).objects[0];
  source=(await commit([changeFor(source,{...source.data,body:'新的材料正文，旧证据不能被静默替换。'})])).objects[0];
  const old=await get(source.id,'?revision=1');assert(validateCitation(ref,old).valid);assert(referenceStatus(ref,old,source).newer);assert(!validateCitation({...ref,quote:'不匹配原文'},old).valid);
  source=(await commit([{...changeFor(source,source.data),deleted:true}])).objects[0];assert.equal((await get(knowledge.id)).data.citations[0].revision,1);assert(referenceStatus(ref,old,source).deleted);
  source=(await commit([{...changeFor(source,source.data),deleted:false}])).objects[0];assert.equal(source.id,'qa_source');
 });
 await run('C06_live_retry','引用后来变化仍能重放已确认请求',async()=>{
  const current=await get(source.id);const change=createChange('knowledge',{title:'跟随引用的提交重放',body:'保留原提交回执',kind:'question',citations:[{targetId:source.id,versionMode:'live',revision:null,locator:null,quote:current.data.body}]});const body={requestId:next('live_replay'),changes:[change]};const first=await request('/api/commit',body);source=(await commit([changeFor(current,{...current.data,body:'后来改变了这份来源。'})])).objects[0];assert.deepEqual(await request('/api/commit',body),first);
 });
 await run('C07','六类对象过期版本提交不覆盖已确认内容',async()=>{
  const sourceData={title:'冲突来源',body:'原始',format:'text',parseStatus:'ready',attachmentIds:[],citations:[]};
  const defs=[['entry',entry('原始')],['document',{title:'文稿',body:'原始',blocks:[],citations:[]}],['knowledge',{title:'观点',body:'原始',kind:'claim',citations:[]}],['source',sourceData],['persona',{name:'验收人物',style:'',interpretation:'',sourceIds:[]}],['place',{name:'验收城',kind:'custom',aliases:[],coordinates:[115,35]}]];
  for(const [type,data]of defs){const first=(await commit([createChange(type,data,next(type))])).objects[0];const changed={...data,...(type==='place'?{name:'已确认新城'}:type==='persona'?{name:'已确认新人物'}:{body:'已确认的新正文'})};const second=(await commit([changeFor(first,changed)])).objects[0];const conflict=await request('/api/commit',{requestId:next('conflict'),changes:[changeFor(first,data)]},409);assert.equal(conflict.error.code,'VERSION_CONFLICT');assert.deepEqual((await get(first.id)).data,second.data);}
 });
 await run('A01_A04','真实 HTTP 对话协议只发送冻结范围与选定上下文',async()=>{
  const scopeSource=(await commit([createChange('source',{title:'范围冻结材料',body:'河流与城市相互影响。知识需要留下证据。',format:'text',parseStatus:'ready',attachmentIds:[],citations:[]},'qa_scope_source')])).objects[0];
  const received=[];provider=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);received.push(input);const payload=JSON.stringify({segments:[{kind:'interpretation',text:'这是验收用的模拟协议响应。'},{kind:'quote',sourceId:'qa_scope_source',revision:1,text:'河流与城市相互影响。',locator:{start:0,end:10}}]});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:payload}}]}));});await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  await request('/api/settings',{endpoint:'http://127.0.0.1:'+provider.address().port+'/v1',model:'protocol-fixture',apiKey:secret});
  await commit([prepareEntryChange(entry(privateText),null,'qa_private')]);
  const persona=(await request('/api/personas/save',{requestId:next('persona'),newId:'qa_persona',data:{name:'验收讨论伙伴',style:'仔细核对',interpretation:'测试人物',sourceIds:[scopeSource.id]}})).persona;
  discussion=(await request('/api/personas/start',{requestId:next('discussion'),personaId:persona.id,contextRefs:[refOf(knowledge)]})).discussion;
  await commit([changeFor(scopeSource,{...scopeSource.data,body:'新的材料正文，不能送进已冻结的旧讨论。'})]);
  const result=await request('/api/personas/send',{requestId:next('send'),discussionId:discussion.id,body:'河流与城市有什么关系？'});message=result.message;
  assert.equal(message.data.status,'complete');assert.equal(message.data.citations.length,1);assert.equal(message.data.citations[0].revision,1);
  const sent=JSON.stringify(received);assert(!sent.includes(privateText));assert(!sent.includes('新的材料正文'));assert(sent.includes('河流与城市相互影响'));assert(sent.includes('我的观点'));assert(!sent.includes(secret));
  return{provider:'Loopback protocol stub; not a real model evaluation',requestCount:received.length};
 });
 await run('A03','越范围引用不能伪装为原文',async()=>{
  const {parseResponse}=await import('../../features/personas/service.js');const parsed=await parseResponse(JSON.stringify({segments:[{kind:'quote',sourceId:'qa_private',revision:1,text:privateText},{kind:'quote',sourceId:'qa_source',revision:4,text:'编造引文'}]}),app.workspace,[{sourceId:'qa_source',revision:1}]);assert.equal(parsed.citations.length,0);assert(parsed.segments.every(s=>s.kind==='inference'&&s.rejectedCitation));assert(!parsed.body.includes(privateText));
 });
 await run('A05','无模型时明确失败，普通保存继续可用',async()=>{
  await request('/api/settings',{endpoint:'',model:''});const result=await request('/api/personas/send',{requestId:next('unconfigured'),discussionId:discussion.id,body:'不能假装回答'},422);assert.equal(result.error.code,'SERVICE_NOT_CONFIGURED');const saved=await commit([prepareEntryChange(entry('模型离线仍能写史书'))]);assert(saved.objects[0].id);
 });
 await run('HTTP03','设置不回显密钥，静态资源不能读取设置',async()=>{
  const settings=await request('/api/settings');assert(!JSON.stringify(settings).includes(secret));assert.equal(settings.hasApiKey,true);assert(!('apiKey'in settings));assert.equal((await fetch(base+'/apps/client/..%2F..%2F.local/settings.json')).status,404);
 });
 await run('R10_K06','采纳原子提交、幂等与创建型撤销',async()=>{
  const body={requestId:next('adopt'),messageId:message.id,messageRevision:message.revision,targetType:'knowledge',kind:'question',title:'采纳的问题',body:'为什么河流影响城市？'};adoption=await request('/api/adopt',body);
  const target=await get(adoption.targetId);assert.equal(target.data.citations.at(-1).targetId,message.id);assert.equal(target.data.citations.at(-1).revision,message.revision);
  for(let i=0;i<3;i++)assert.equal((await request('/api/adopt',body)).commitId,adoption.commitId);
  const undoBody={requestId:next('undo')};const undone=await request('/api/adopt/'+adoption.adoptionId+'/undo',undoBody);for(let i=0;i<3;i++)assert.deepEqual(await request('/api/adopt/'+adoption.adoptionId+'/undo',undoBody),undone);const repeated=await request('/api/adopt/'+adoption.adoptionId+'/undo',{requestId:next('already_undone')});assert.equal(repeated.alreadyUndone,true);assert((await get(adoption.targetId,'?includeDeleted=true')).deletedAt);assert.equal((await get(message.id)).data.status,'complete');
  assert.equal((await request('/api/adopt',body)).commitId,adoption.commitId);
 });
 await run('K06_conflict','撤销不会覆盖采纳后的编辑',async()=>{
  const taken=await request('/api/adopt',{requestId:next('adopt'),messageId:message.id,messageRevision:message.revision,targetType:'knowledge',kind:'claim',body:'采纳后要继续编辑'});const target=await get(taken.targetId);await commit([changeFor(target,{...target.data,body:'这段后续编辑必须保留'})]);const error=await request('/api/adopt/'+taken.adoptionId+'/undo',{requestId:next('undo')},409);assert.equal(error.error.code,'VERSION_CONFLICT');assert.equal((await get(target.id)).data.body,'这段后续编辑必须保留');
 });
 await run('K06_stale_adoption','采纳修订必须基于用户看过的目标版本',async()=>{
  const old=await get(knowledge.id);await commit([changeFor(old,{...old.data,body:'另一窗口刚写下的内容'})]);const result=await request('/api/adopt',{requestId:next('stale_adopt'),messageId:message.id,messageRevision:message.revision,targetType:'knowledge',targetId:old.id,targetRevision:old.revision,body:'不得覆盖的新采纳'},409);assert.equal(result.error.code,'VERSION_CONFLICT');assert.equal((await get(old.id)).data.body,'另一窗口刚写下的内容');
 });
 await run('R10_existing_undo','修订型采纳撤销建立新版本并保留原始正文',async()=>{
  const before=await get(knowledge.id);const taken=await request('/api/adopt',{requestId:next('existing_adopt'),messageId:message.id,messageRevision:message.revision,targetType:'knowledge',targetId:before.id,targetRevision:before.revision,body:before.data.body+'\n\n讨论之后的补充。'});assert.equal(taken.targetId,before.id);await request('/api/adopt/'+taken.adoptionId+'/undo',{requestId:next('undo_existing')});const current=await get(before.id);assert.equal(current.revision,before.revision+2);assert.deepEqual(current.data,before.data);assert.equal((await get(before.id,'?revision='+(before.revision+1))).data.body,before.data.body+'\n\n讨论之后的补充。');
 });
 await run('C09','暂停索引水位可辨且100项积压恢复后收敛',async()=>{
  app.workspace.setIndexingPaused(true);const changes=Array.from({length:100},(_,i)=>prepareEntryChange(entry('索引恢复验收专用词 '+i),null,'qa_index_'+i));await commit(changes);assert.equal((await get('qa_index_0')).data.body,'索引恢复验收专用词 0');const lag=await request('/api/objects?objectType=entry&q='+encodeURIComponent('索引恢复验收专用词'));assert(lag.indexedThroughSequence<lag.sequence);const start=performance.now();app.workspace.setIndexingPaused(false);const recovered=await request('/api/objects?objectType=entry&q='+encodeURIComponent('索引恢复验收专用词'));assert.equal(recovered.total,100);assert.equal(recovered.indexedThroughSequence,recovered.sequence);assert(performance.now()-start<=5000);return{recoveryMs:+(performance.now()-start).toFixed(1)};
 });
 await run('HTTP04','中断与用户消息不进入采纳链',async()=>{
  for(const [role,status] of [['assistant','interrupted'],['user','complete']]){const msg=app.workspace.commit({requestId:next('fixture'),changes:[createChange('message',{discussionId:discussion.id,role,status,body:'不得被采纳',citations:[],contentKind:role==='user'?'user':'inference'})]}).objects[0];await request('/api/adopt',{requestId:next('forbidden'),messageId:msg.id,targetType:'entry'},400);}
 });
 await run('D01_D03','完整备份恢复并逐版本、实际附件摘要核对',async()=>{
  const bytes=Buffer.from('附件真实内容：中文与长文件名。'.repeat(1000));const attached=await fetch(base+'/api/attachments?name='+encodeURIComponent('验收-中文长文件名-附件.bin'),{method:'POST',headers:{'X-Chronicle-Token':token},body:bytes});assert.equal(attached.status,200);const metadata=await attached.json();
  await commit([createChange('source',{title:'附件材料',body:'',format:'attachment',parseStatus:'unparsed',attachmentIds:[metadata.id],citations:[]})]);const before=snapshot(app.workspace),beforeHash=digest(before),oldDirectory=app.workspace.directory;
  const transferId=next('export');const exported=await request('/api/backup/export?transferId='+transferId,{});const progress=await request('/api/backup/progress/'+transferId);assert.equal(progress.phase,'complete');assert(progress.completedBytes>0);const archive=Buffer.from(await(await fetch(base+exported.url)).arrayBuffer());assert(!archive.includes(Buffer.from(secret)));await writeFile(path.join(output,'acceptance.chronicle'),archive);
  const corrupt=Buffer.from(archive);corrupt[corrupt.length-1]^=1;const bad=await fetch(base+'/api/backup/import',{method:'POST',headers:{'X-Chronicle-Token':token},body:corrupt});assert(!bad.ok);assert.equal(digest(snapshot(app.workspace)),beforeHash);
  const restored=await fetch(base+'/api/backup/import',{method:'POST',headers:{'X-Chronicle-Token':token},body:archive});assert.equal(restored.status,200,await restored.text());assert.notEqual(app.workspace.directory,oldDirectory);assert.equal(digest(snapshot(app.workspace)),beforeHash);
  const actual=Buffer.from(await(await fetch(base+'/api/attachments/'+metadata.id)).arrayBuffer());assert.equal(digest(actual),digest(bytes));return{objects:before.length,allRevisionHash:beforeHash,actualAttachmentHash:digest(actual)};
 });
 await run('R01_R03_R05_N02','真实浏览器一句记录、草稿刷新恢复、离线写入',async()=>{
  const playwright=await browserEngine();browser=await playwright.chromium.launch({channel:'msedge',headless:true});report.environment.browser=await browser.version();const page=await browser.newPage({viewport:{width:1440,height:900}});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));await page.route('**/*',route=>{const url=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(url.hostname)?route.continue():route.abort();});
  await page.goto(base);await page.locator('.chronicle-root').waitFor({state:'attached'});await page.getByRole('button',{name:'＋ 记一笔',exact:true}).click();const input=page.getByRole('textbox',{name:'记录正文',exact:true});const body='浏览器验收草稿：中文输入，换行。\n\n刷新后继续，正文不应丢失。';await input.fill(body);await poll(()=>app.workspace.list({objectType:'draft',q:'浏览器验收草稿'}).total===1);await page.reload();await page.getByRole('button',{name:'继续书写',exact:true}).click();await page.getByRole('textbox',{name:'记录正文',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'记录正文',exact:true}).inputValue(),body);
  const refreshed=page.getByRole('textbox',{name:'记录正文',exact:true});await refreshed.dispatchEvent('compositionstart');await refreshed.press('Control+Enter');assert.equal(app.workspace.list({objectType:'entry',q:'浏览器验收草稿'}).total,0);await refreshed.dispatchEvent('compositionend');await page.getByRole('button',{name:'记下',exact:true}).click();await page.getByRole('button',{name:'编辑',exact:true}).waitFor();assert.equal(app.workspace.list({objectType:'entry',q:'浏览器验收草稿'}).total,1);
  for(const viewport of [{width:1024,height:768},{width:1440,height:900},{width:1920,height:1080}]){await page.setViewportSize(viewport);await page.screenshot({path:path.join(output,'chronicle-'+viewport.width+'.png'),fullPage:true});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);assert.equal(overflow,false,'Page must not overflow horizontally at '+viewport.width);}
  await page.setViewportSize({width:720,height:450});await page.screenshot({path:path.join(output,'chronicle-zoom200-equivalent.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'200% equivalent viewport overflows');const proseWidth=await page.locator('.chronicle-prose').evaluate(e=>e.getBoundingClientRect().width);assert(proseWidth>=240,'Equivalent zoom must keep prose readable');assert.deepEqual(pageErrors,[]);await page.close();return{pageErrors,screenshots:output,zoom:'720×450 CSS viewport checks equivalent layout of a 1440×900 window at 200%; browser zoom control itself not automated',ime:'Synthetic composition events only; real OS Chinese IME still requires human testing'};
 });
 await run('M06','底图资源失败时仍能记录与查找',async()=>{
  const page=await browser.newPage({viewport:{width:1024,height:768}});await page.route('**/features/atlas/data/land.geojson',r=>r.abort());await page.goto(base);await page.getByText(/可以继续使用上方地点搜索/).waitFor();await page.getByRole('button',{name:'＋ 记一笔',exact:true}).click();await page.getByRole('textbox',{name:'记录正文',exact:true}).fill('地图故障不妨碍保存的验收文字。');await page.getByRole('button',{name:'记下',exact:true}).click();await page.getByRole('button',{name:'编辑',exact:true}).waitFor();assert.equal(app.workspace.list({objectType:'entry',q:'地图故障不妨碍保存'}).total,1);await page.screenshot({path:path.join(output,'map-resource-failure.png'),fullPage:true});await page.close();
 });
}finally{await browser?.close();if(provider)await new Promise(r=>provider.close(r));await app.close();report.passed=report.cases.filter(c=>c.status==='passed').length;report.failed=report.cases.filter(c=>c.status==='failed').length;await writeReport('acceptance-latest.json',report);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failed:report.failed,report:'quality/acceptance-latest.json'},null,2));if(report.failed)process.exitCode=1;}
