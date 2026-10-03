import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createAppServer} from '../../apps/server/main.js';
import {parseTime} from '../../features/atlas/time.js';
import {browserEngine,environment,metrics,writeReport} from '../fixtures/harness.mjs';

// This supplements, rather than reruns, the costly full fixture/backup benchmark.
const baseline=JSON.parse(await readFile('quality/performance-latest.json','utf8'));
const dataDir=path.join(baseline.output,'data');
const prefix='ui_feedback_'+Date.now();
const report={suite:'V1 real browser submission, query and map feedback',environment:await environment(),dataDir,originalDataset:baseline.dataset,fixturePrefix:prefix,results:{},samples:{},limitations:[
  'This is the existing full V1 synthetic workspace with prior performance additions and 100 more test places/entries; the default user workspace is never opened.',
  'Warm OS/filesystem and running local service on the development host; not certified R0 and not a cold-start result.',
  'Native browser events and actual DOM/canvas output are observed; the next animation frame provides a paint opportunity but does not measure physical monitor scan-out.',
  'No actual model, human participant, mobile device, or operating-system Chinese IME quality claim is made.',
  'Background OS/developer activity is not controlled; external browser requests are blocked.'
]};
let browser,app;
try{
 app=await createAppServer({dataDir,seed:false});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 const get=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
 app.workspace.commit({requestId:prefix+'_places',changes:Array.from({length:100},(_,i)=>({id:prefix+'_place_'+i,objectType:'place',expectedRevision:0,data:{name:'可见反馈测量地点'+i,kind:'custom',coordinates:[-60+i*1.5,30],aliases:[]}}))});
 report.startingStats=app.workspace.stats();
 const engine=await browserEngine();browser=await engine.chromium.launch({channel:'msedge',headless:true});report.environment.browser=browser.version();
 const context=await browser.newContext({viewport:{width:1440,height:900}});const blocked=[];
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(url.hostname))return route.continue();blocked.push(url.origin);return route.abort();});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const probe=window.__feedback={draws:0,current:null};
  const original=CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.matches('.atlas-map'))probe.draws++;return original.apply(this,args);};
  const digest=()=>{const canvas=document.querySelector('.atlas-map');const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let hash=2166136261;for(let i=0;i<pixels.length;i++){hash^=pixels[i];hash=Math.imul(hash,16777619);}return(hash>>>0).toString(16);};
  probe.arm=config=>{probe.current={...config,start:null,done:false,drawsBefore:probe.draws,hashBefore:document.querySelector('.atlas-map')?digest():null};};
  const start=event=>{const p=probe.current;if(!p||p.start!==null)return;const target=event.target;
   const matches=(p.kind==='commit'&&event.type==='click'&&target.closest('button')?.textContent.trim()==='记下')||(p.kind==='query'&&event.type==='input'&&target.getAttribute('aria-label')==='搜索史书'&&target.value===p.query)||(p.kind==='time'&&event.type==='submit'&&target.matches('.atlas-time-row'));
   if(!matches)return;p.start=performance.now();p.drawsBefore=probe.draws;
   const tick=()=>{if(probe.current!==p||p.done)return;
    const titles=[...document.querySelectorAll('.chronicle-record-title')].map(n=>n.textContent);
    const summary=document.querySelector('.atlas-summary')?.textContent;
    const ready=p.kind==='query'?titles.length>0&&titles.every(t=>t.startsWith(p.query))&&!document.querySelector('.chronicle-list-controls').textContent.includes('读取中'):summary===p.summary&&probe.draws>p.drawsBefore;
    if(ready){requestAnimationFrame(()=>{p.done=true;p.duration=performance.now()-p.start;p.drawsAfter=probe.draws;p.hashAfter=digest();p.summary=summary;p.renderedIds=[...document.querySelectorAll('.chronicle-record-row')].map(n=>n.dataset.objectId);});return;}
    if(performance.now()-p.start>15000){p.error='No matching visible output within 15 seconds';p.done=true;return;}requestAnimationFrame(tick);
   };requestAnimationFrame(tick);
  };
  for(const type of ['input','click','submit'])document.addEventListener(type,start,true);
 });
 await page.goto(base);await page.locator('.atlas-map').waitFor();await page.waitForFunction(()=>document.querySelector('.atlas-map-status')?.hidden&&window.__feedback.draws>0);await page.waitForLoadState('networkidle');
 const arm=config=>page.evaluate(config=>window.__feedback.arm(config),config);
 const finish=async()=>{await page.waitForFunction(()=>window.__feedback.current?.done,{},{timeout:20000});const result=await page.evaluate(()=>window.__feedback.current);assert(!result.error,result.error);assert(result.start!==null);return result;};
 const summaries=data=>`${data.total??0} 条已定位记录 · ${(data.explored||[]).length} 个点亮地点${data.unlocatedCount?` · ${data.unlocatedCount} 条待定位`:''}`;
 let atlas=await get('/api/atlas');
 const commitSamples=[];
 for(let i=0;i<100;i++){
  await page.getByRole('button',{name:'＋ 记一笔',exact:true}).click();
  await page.getByRole('textbox',{name:'记录正文',exact:true}).fill('可见反馈测量 '+prefix+' '+i+'。这是一条仅用于工程验收的合成记录。');
  await page.getByRole('textbox',{name:'发生时间',exact:true}).fill('1855');
  await page.getByRole('combobox',{name:'添加关联地点',exact:true}).selectOption(prefix+'_place_'+i);
  const expected={...atlas,total:atlas.total+1,explored:[...atlas.explored,prefix+'_place_'+i]};
  await arm({kind:'commit',summary:summaries(expected)});
  const commitResponse=page.waitForResponse(response=>{if(!response.url().endsWith('/api/commit'))return false;try{return response.request().postDataJSON().changes.some(c=>c.objectType==='entry');}catch{return false;}});
  await page.getByRole('button',{name:'记下',exact:true}).click();
  const response=await commitResponse;assert.equal(response.status(),200);const saved=(await response.json()).objects.find(o=>o.objectType==='entry');assert(saved);
  const sample=await finish();assert(sample.drawsAfter>sample.drawsBefore);commitSamples.push({...sample,entryId:saved.id,placeId:prefix+'_place_'+i});
  atlas=await get('/api/atlas');assert.equal(summaries(atlas),summaries(expected));assert(atlas.explored.includes(prefix+'_place_'+i));
  if(i%20===19)console.log('P03 visible map samples '+(i+1));
 }
 report.samples.commitToMap=commitSamples;report.results.commitToMapUI={...metrics(commitSamples.map(s=>s.duration)),targetP95Ms:1000,measurement:'Native save-button click through successful persisted Entry, expected atlas summary, actual canvas clear/redraw and next animation frame',distinctCanvasHashes:new Set(commitSamples.map(s=>s.hashAfter)).size};
 await page.getByRole('textbox',{name:'时间范围',exact:true}).fill('1855');await page.locator('.atlas-time-row').getByRole('button',{name:'进入',exact:true}).click();
 await page.getByRole('combobox',{name:'记录类型',exact:true}).selectOption('note');await page.waitForLoadState('networkidle');
 const querySamples=[];
 for(let i=0;i<100;i++){
  const query=i%2?'长文-':'普通-';await arm({kind:'query',query});
  const responsePromise=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/objects'&&u.searchParams.get('objectType')==='entry'&&u.searchParams.get('q')===query&&u.searchParams.get('kind')==='note'&&u.searchParams.has('timeSpec');});
  await page.getByRole('searchbox',{name:'搜索史书',exact:true}).fill(query);const response=await responsePromise;assert.equal(response.status(),200);const result=await response.json();
  const sample=await finish();assert.deepEqual([...sample.renderedIds].sort(),result.items.map(o=>o.id).sort());assert.equal(new Set(sample.renderedIds).size,sample.renderedIds.length);assert(result.items.every(o=>o.data.kind==='note'&&o.data.title.startsWith(query)));querySamples.push({...sample,total:result.total});
  if(i%20===19)console.log('P04 rendered query samples '+(i+1));
 }
 report.samples.query=querySamples;report.results.queryRenderedUI={...metrics(querySamples.map(s=>s.duration)),targetP95Ms:800,measurement:'Native search input event, including 180 ms debounce, while note type and 1855 time filters are active; exact response IDs deduplicated in actual rendered rows plus next animation frame'};
 await page.getByRole('searchbox',{name:'搜索史书',exact:true}).fill('');await page.getByRole('combobox',{name:'记录类型',exact:true}).selectOption('');await page.waitForLoadState('networkidle');
 const expected1855=await get('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime('1855'))));const expected1870=await get('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime('1870'))));
 assert.notEqual(summaries(expected1855),summaries(expected1870));
 const timeSamples=[];
 for(let i=0;i<100;i++){
  const year=i%2?'1855':'1870',expected=year==='1855'?expected1855:expected1870;
  await page.getByRole('textbox',{name:'时间范围',exact:true}).fill(year);await arm({kind:'time',summary:summaries(expected)});
  const responsePromise=page.waitForResponse(r=>{const u=new URL(r.url());if(u.pathname!=='/api/atlas')return false;try{return JSON.parse(u.searchParams.get('time')).originalText===year;}catch{return false;}});
  await page.locator('.atlas-time-row').getByRole('button',{name:'进入',exact:true}).click();const response=await responsePromise;assert.equal(response.status(),200);const data=await response.json();assert.equal(summaries(data),summaries(expected));
  const sample=await finish();assert(sample.drawsAfter>sample.drawsBefore);assert.notEqual(sample.hashAfter,sample.hashBefore,'Changing populated vs empty layer must change actual canvas pixels');timeSamples.push({...sample,year});
  // Drain this action's coupled directory load before beginning the next sample.
  await page.waitForFunction(()=>!document.querySelector('.chronicle-list-controls').textContent.includes('读取中'));
  if(i%20===19)console.log('P05 painted map samples '+(i+1));
 }
 report.samples.time=timeSamples;report.results.timeToMapUI={...metrics(timeSamples.map(s=>s.duration)),targetP95Ms:500,measurement:'Native time-form submit through correct atlas summary and changed actual canvas pixel digest, then next animation frame; real coupled directory query remains enabled',distinctCanvasHashes:new Set(timeSamples.map(s=>s.hashAfter)).size};
 for(const result of Object.values(report.results))result.targetMetOnThisHost=result.p95Ms<=result.targetP95Ms;
 report.browserErrors=errors;report.blockedExternalOrigins=[...new Set(blocked)];assert.deepEqual(errors,[]);report.endingStats=app.workspace.stats();report.status='completed';
}catch(error){report.status='failed';report.error=error.stack;console.error(error);process.exitCode=1;}finally{await browser?.close();await app?.close();await writeReport('performance-ui.json',report);console.log(JSON.stringify({status:report.status,results:report.results,error:report.error,report:'quality/performance-ui.json'},null,2));}
