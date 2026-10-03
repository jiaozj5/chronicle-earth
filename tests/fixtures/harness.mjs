import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createAppServer} from '../../apps/server/main.js';

export const root=path.resolve(new URL('../..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
export async function environment(){return{date:new Date().toISOString(),node:process.version,platform:process.platform,osRelease:os.release(),osVersion:os.version(),cpu:os.cpus()[0]?.model,logicalProcessors:os.cpus().length,totalMemoryGiB:+(os.totalmem()/2**30).toFixed(2),storage:'Filesystem on execution host; SSD type not independently verified',referenceR0Verified:false,network:'Local application and simulated provider use loopback; explicit request-blocking is described by each scenario'};}
export async function testServer(label,{seed=true}={}){
 const output=path.resolve('.test-data',label+'-'+Date.now());await mkdir(output,{recursive:true});
 const app=await createAppServer({dataDir:path.join(output,'data'),seed});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 const token=(await(await fetch(base+'/api/session')).json()).token;
 const request=async(route,body,expected=200,options={})=>{
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Chronicle-Token':token,...options.headers},body:body===undefined?undefined:JSON.stringify(body),...options});
  const text=await response.text();let result;try{result=JSON.parse(text);}catch{result=text;}
  assert.equal(response.status,expected,`${route}: ${JSON.stringify(result)}`);return result;
 };
 return{app,output,base,token,request};
}
export async function browserEngine(){const require=createRequire(import.meta.url);try{return require('playwright');}catch{return require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}}
export function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export function digest(value){return createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(canonical(value))).digest('hex');}
export function snapshot(workspace){const all=workspace.list({includeDrafts:true,includeDeleted:true,limit:1000000}).items;return all.sort((a,b)=>a.id.localeCompare(b.id)).map(o=>({id:o.id,versions:workspace.history(o.id).sort((a,b)=>a.revision-b.revision)}));}
export async function writeReport(name,report){await mkdir('quality',{recursive:true});await writeFile(path.resolve('quality',name),JSON.stringify(report,null,2));}
export function metrics(values){const sorted=[...values].sort((a,b)=>a-b);return{n:values.length,p50Ms:+sorted[Math.ceil(sorted.length*.5)-1].toFixed(2),p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(2),maxMs:+sorted.at(-1).toFixed(2)};}
export async function poll(fn,{timeout=10000,interval=25}={}){const start=performance.now();while(performance.now()-start<timeout){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,interval));}throw new Error('Condition did not become true within '+timeout+' ms');}
