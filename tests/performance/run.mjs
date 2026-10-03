import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,statfs,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Workspace} from '../../packages/workspace/index.js';
import {parseTime} from '../../features/atlas/time.js';
import {projectAtlas} from '../../features/atlas/service.js';
import {testServer,environment,writeReport,metrics,canonical,browserEngine} from '../fixtures/harness.mjs';
import {seedPerformance,shape} from '../fixtures/performance-data.mjs';
const {app,request,base,output}=await testServer('performance',{seed:false});
const report={suite:'V1 full-size synthetic benchmark',environment:await environment(),output,dataset:shape,results:{},limitations:['Execution host is not certified R0 hardware.','Cold OS cache and physical SSD class are not independently controlled.','Model and real-user quality are excluded.']};
let browser;
async function measure(n,fn){const values=[];for(let i=0;i<n;i++){const start=performance.now();await fn(i);values.push(performance.now()-start);}return metrics(values);}
function revisionDigest(directory){const db=new DatabaseSync(path.join(directory,'workspace.sqlite'),{readOnly:true}),hash=createHash('sha256');let count=0;try{for(const row of db.prepare('SELECT json FROM revisions ORDER BY object_id,revision').iterate()){hash.update(JSON.stringify(canonical(JSON.parse(row.json)))).update('\n');count++;}return{count,sha256:hash.digest('hex')};}finally{db.close();}}
async function fileDigest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
try{
 const space=await statfs(output);report.environment.freeGiBBefore=+(space.bavail*space.bsize/2**30).toFixed(2);assert(space.bavail*space.bsize>8*2**30,'Full benchmark needs at least 8 GiB free');
 const seedStart=performance.now();let last=0;const fixture=await seedPerformance(app.workspace,{onProgress:p=>{if(performance.now()-last>4000){console.log(JSON.stringify(p));last=performance.now();}}});report.seedMs=performance.now()-seedStart;report.fixtureObjects=fixture.objects;report.fixtureRevisions=fixture.revisions;console.log('Full V1 fixture persisted');
 report.results.queryHTTP={...await measure(100,i=>request('/api/objects?objectType=entry&q='+encodeURIComponent('河流')+'&kind='+(i%2?'prediction':'note')+'&timeSpec='+encodeURIComponent(JSON.stringify(parseTime('1855')))+'&summary=true&limit=30')),targetP95Ms:800,measurement:'HTTP complete response, warm SQLite index'};
 report.results.atlasHTTP={...await measure(100,i=>request('/api/atlas?time='+encodeURIComponent(JSON.stringify(parseTime(i%2?'1855':'1860'))))),targetP95Ms:500,measurement:'HTTP projection response; excludes final browser painting'};
 report.results.commitHTTP={...await measure(100,i=>request('/api/commit',{requestId:'perf_save_'+i,changes:[{id:'perf_saved_'+i,objectType:'entry',expectedRevision:0,data:{title:'测量提交'+i,body:'实际持久化写入的验收记录。',kind:'note',status:'adopted',placeRefs:[],occurrenceTime:null,citations:[]}}]})),targetP95Ms:500,measurement:'HTTP success after SQLite FULL commit'};
 const records=app.workspace.list({objectType:'entry',limit:10000}).items.map(o=>({...o,data:{...o.data,occurrenceTime:parseTime('1855'),placeRefs:[{placeId:'perf_place_0',confirmed:true}]}}));const places=app.workspace.list({objectType:'place',limit:500}).items;
 const dense=projectAtlas(records,places,parseTime('1855'));assert.equal(dense.markers.length,1);assert.equal(dense.markers[0].recordCount,10000);report.results.denseScene={entries:10000,markers:dense.markers.length,count:dense.markers[0].recordCount};
 const playwright=await browserEngine();browser=await playwright.chromium.launch({channel:'msedge',headless:true});report.environment.browser=await browser.version();
 report.results.startupFreshContext={...await measure(10,async()=>{const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();await page.goto(base);await page.getByRole('button',{name:'＋ 记一笔',exact:true}).click();await page.getByRole('textbox',{name:'记录正文',exact:true}).waitFor();await context.close();}),targetP95Ms:3000,measurement:'Fresh browser context/cache; warmed OS and running local service, includes context close; not cold OS startup'};
 const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('.chronicle-root').waitFor({state:'attached'});
 const openMetrics=async(query)=>{await page.getByRole('searchbox',{name:'搜索史书'}).fill(query);await page.waitForTimeout(350);const rows=page.locator('.chronicle-record-row');await rows.first().waitFor();const count=await rows.count();return measure(100,async i=>{const row=rows.nth(i%Math.min(count,10)),id=await row.getAttribute('data-object-id');const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/objects/'+id);await row.click();await response;await page.waitForFunction(expected=>document.querySelector('.chronicle-record-row.selected')?.dataset.objectId===expected&&!!document.querySelector('.chronicle-prose'),id);});};
 report.results.openNormalUI={...await openMetrics('普通-'),targetP95Ms:300,measurement:'Loaded directory row click to selected rendered prose in Edge'};
 report.results.openLongUI={...await openMetrics('长文-'),targetP95Ms:800,measurement:'100 KiB entry row click to selected rendered prose in Edge'};
 await page.screenshot({path:path.join(output,'full-dataset-long-reading.png'),fullPage:true});report.browserErrors=errors;await page.close();await browser.close();browser=null;
 const before=revisionDigest(app.workspace.directory),backupRuns=[];
 for(let i=0;i<3;i++){
  const archive=path.join(output,'full-'+i+'.chronicle');let callbacks=0,lastBytes=0;const exportStart=performance.now();await app.workspace.exportBackup(archive,{onProgress:p=>{callbacks++;if(p.completedBytes!=null)lastBytes=p.completedBytes;}});const exportMs=performance.now()-exportStart;
  const restored=new Workspace(path.join(output,'restore-'+i));let restoreCallbacks=0;const restoreStart=performance.now();await restored.importBackup(archive,{onProgress:()=>restoreCallbacks++});const restoreMs=performance.now()-restoreStart;
  const after=revisionDigest(restored.directory);assert.deepEqual(after,before);let attachmentChecks=0;for(const metadata of fixture.attachments){assert.equal(await fileDigest(path.join(restored.attachmentsPath,metadata.id)),metadata.expectedHash);attachmentChecks++;}
  restored.close();backupRuns.push({exportMs:+exportMs.toFixed(1),restoreMs:+restoreMs.toFixed(1),targetMs:120000,progressCallbacks:{export:callbacks,restore:restoreCallbacks},bytes:lastBytes,revisionDigest:after,actualAttachmentsRehashed:attachmentChecks});console.log('Backup run '+i+' '+JSON.stringify(backupRuns.at(-1)));
  // Only remove this run's generated archive and restored test workspace after independent verification.
  const resolved=path.resolve(path.join(output,'restore-'+i));assert(resolved.startsWith(path.resolve(output)+path.sep));await rm(resolved,{recursive:true,force:true});await rm(archive,{force:true});
 }
 report.results.backup=backupRuns;report.status='completed';
 for(const result of Object.values(report.results))if(result?.targetP95Ms)result.targetMetOnThisHost=result.p95Ms<=result.targetP95Ms;
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1;console.error(error);}finally{await browser?.close();await app.close();await writeReport('performance-latest.json',report);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,results:report.results,report:'quality/performance-latest.json'},null,2));}
