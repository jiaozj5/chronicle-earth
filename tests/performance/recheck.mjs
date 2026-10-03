import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createAppServer} from '../../apps/server/main.js';
import {parseTime} from '../../features/atlas/time.js';
import {environment,writeReport,metrics,browserEngine,poll} from '../fixtures/harness.mjs';
const original=JSON.parse(await readFile('quality/performance-latest.json','utf8'));
const app=await createAppServer({dataDir:path.join(original.output,'data'),seed:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const report={suite:'Focused performance recheck using the full persisted V1 fixture',environment:await environment(),originalReport:'quality/performance-latest.json',originalDataset:original.dataset,results:{},scope:'Does not replace the three independently verified full backup runs',backgroundLoad:'No other benchmark intentionally run in parallel; OS/background developer activity uncontrolled'};report.environment.network='Browser blocks non-loopback requests; all test API is local';
let browser;
async function measure(n,fn){const values=[];for(let i=0;i<n;i++){const t=performance.now();await fn(i);values.push(performance.now()-t);}return metrics(values);}
const request=async route=>{const r=await fetch(base+route);assert(r.ok,await r.clone().text());return r.json();};
try{
 report.results.queryHTTP={...await measure(100,async i=>{const r=await request('/api/objects?objectType=entry&q='+encodeURIComponent('河流')+'&kind='+(i%2?'prediction':'note')+'&timeSpec='+encodeURIComponent(JSON.stringify(parseTime('1855')))+'&summary=true&limit=30');assert(r.total>0);assert.equal(r.items.length,30);}),targetP95Ms:800};console.log('query '+JSON.stringify(report.results.queryHTTP));
 report.results.atlasHTTP={...await measure(100,i=>request('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime(i%2?'1855':'1860'))))),targetP95Ms:500};console.log('atlas '+JSON.stringify(report.results.atlasHTTP));
 report.results.atlasVariedHTTP={...await measure(100,i=>request('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime(String(1800+i)))))),targetP95Ms:500};console.log('varied atlas '+JSON.stringify(report.results.atlasVariedHTTP));
 const playwright=await browserEngine();browser=await playwright.chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});await page.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());await page.goto(base);await page.getByRole('button',{name:'＋ 记一笔',exact:true}).click();const input=page.getByRole('textbox',{name:'记录正文',exact:true});await input.fill('性能输入验证：');
 report.results.inputVisibleUI={...await measure(100,async()=>{await input.press('a');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));}),targetP95Ms:100,measurement:'Key dispatch through next animation frame; English keystrokes, not OS Chinese IME'};console.log('input '+JSON.stringify(report.results.inputVisibleUI));
 report.results.draftPersistedUI={...await measure(100,async i=>{const body='草稿停止输入实测 '+i+' '+Date.now();await input.fill(body);await poll(()=>app.workspace.list({objectType:'draft',q:body,limit:1}).items.some(o=>o.data.body===body),{interval:10,timeout:3000});await page.getByText('草稿已保存到本机',{exact:true}).waitFor();}),targetMaxMs:1000,measurement:'Fill completion to actual SQLite draft and UI saved label'};console.log('draft '+JSON.stringify(report.results.draftPersistedUI));
 await page.close();await browser.close();browser=null;report.status='completed';for(const r of Object.values(report.results)){if(r.targetP95Ms)r.targetMetOnThisHost=r.p95Ms<=r.targetP95Ms;if(r.targetMaxMs)r.targetMetOnThisHost=r.maxMs<=r.targetMaxMs;}
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;console.error(e);}finally{await browser?.close();await app.close();await writeReport('performance-recheck.json',report);console.log(JSON.stringify(report,null,2));}
