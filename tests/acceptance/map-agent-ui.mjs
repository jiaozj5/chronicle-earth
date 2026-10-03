import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {testServer,browserEngine,poll,writeReport} from '../fixtures/harness.mjs';

const test=await testServer('map-agent-ui'),pending=new Map();let serial=0,browser,bridge;
const errors=[],checks=[];
function rpc(method,params){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout: '+method));},20000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function call(name,args){const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.error,JSON.stringify(r));return r.result;}
try{
 bridge=spawn(process.execPath,[path.resolve('scripts/agent-mcp.mjs')],{env:{...process.env,CHRONICLE_URL:test.base},windowsHide:true,stdio:['pipe','pipe','pipe']});
 createInterface({input:bridge.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.resolve(r);pending.delete(r.id);});
 bridge.stderr.on('data',b=>errors.push(b.toString()));
 assert.equal((await rpc('tools/list',{})).error.code,-32600);
 assert.equal((await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'acceptance-test',version:'1'}})).result.protocolVersion,'2025-11-25');
 bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=(await rpc('tools/list',{})).result.tools;assert.equal(tools.length,9);assert.equal(tools.find(t=>t.name==='create_entry').inputSchema.additionalProperties,false);assert.ok(tools.find(t=>t.name==='create_entry').inputSchema.required.includes('requestId'));
 const found=(await call('search_places',{query:'北京'})).structuredContent.result;assert.equal(found.resolution,'unique_exact');const placeId=found.resolvedPlaceId;
 const date=(await call('parse_time',{time:'2026年10月2日'})).structuredContent.result;assert.equal(date.indexed,true);
 const invalid=await call('create_entry',{requestId:'invalid-date',body:'不能误记',kind:'note',status:'adopted',time:'昨天',placeIds:[placeId]});assert.equal(invalid.isError,true);assert.equal(invalid.structuredContent.error.code,'TIME_UNRESOLVED');
 assert.equal((await rpc('tools/call',{name:'execute_shell',arguments:{}})).error.code,-32602);
 checks.push('Real stdio MCP lifecycle, discovery, read tools and structured errors');

 const {chromium}=await browserEngine();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(test.base);await page.waitForFunction(()=>document.querySelector('.atlas-map-status')?.hidden===true);
 assert.equal(await page.locator('.map-reader').isVisible(),false);
 const canvas=await page.locator('.atlas-map').boundingBox();assert.ok(canvas.width>=1200&&canvas.height>=900);
 await page.getByRole('button',{name:'＋ 记一笔',exact:true}).click();await page.getByLabel('记录正文',{exact:true}).fill('收起以后仍保留的草稿');
 await poll(async()=>((await test.request('/api/objects?objectType=draft')).items.some(o=>o.data.body==='收起以后仍保留的草稿')));
 await page.getByRole('button',{name:'收起记录面板',exact:true}).click();assert.equal(await page.locator('.map-reader').isVisible(),false);
 await page.getByRole('button',{name:'记录目录',exact:true}).click();await page.getByRole('button',{name:'正文 / 书写',exact:true}).click();assert.equal(await page.getByLabel('记录正文',{exact:true}).inputValue(),'收起以后仍保留的草稿');
 await page.getByRole('button',{name:'专注阅读',exact:true}).click();assert.ok((await page.locator('.map-reader').boundingBox()).width>900);await page.getByRole('button',{name:'回到地图',exact:true}).click();
 checks.push('Map dominates page; writing pane closes/reopens without discarding the saved draft; reading expands');

 const args={requestId:'external-entry',title:'外部工具记事',body:'从模型工具写入北京的记录',kind:'note',status:'adopted',time:'2026-10-02',placeIds:[placeId]};
 const first=(await call('create_entry',args)).structuredContent,again=(await call('create_entry',args)).structuredContent;assert.equal(first.result.commitId,again.result.commitId);assert.equal(again.replayed,true);const entryId=first.result.objects[0].id;
 await page.getByRole('button',{name:'记录目录',exact:true}).click();
 await page.locator('.chronicle-record-row').filter({hasText:'外部工具记事'}).waitFor({timeout:10000});
 assert.ok((await test.request('/api/atlas')).explored.includes(placeId));
 await page.getByRole('button',{name:'正文 / 书写',exact:true}).click();assert.equal(await page.getByLabel('记录正文',{exact:true}).inputValue(),'收起以后仍保留的草稿');
 checks.push('External model write appears without reload and without replacing the open draft; retry creates no duplicate');

 // Freeze only browser timers so an external write and a subsequent local draft
 // commit both land before the next refresh consumes the change sequence.
 await page.clock.install();await page.clock.pauseAt(Date.now()+100);
 const raced=(await call('create_entry',{...args,requestId:'external-before-draft',title:'草稿保存之前的外部记录'})).structuredContent;
 await page.evaluate(async()=>{const {api}=await import('/apps/client/api.js');await api.commit([{id:'draft-race',objectType:'draft',expectedRevision:0,data:{body:'本地草稿后到达'}}],'local-draft-after-external');});
 await page.clock.runFor(3000);await page.waitForFunction(()=>Array.from(document.querySelectorAll('.chronicle-record-title')).some(n=>n.textContent==='草稿保存之前的外部记录'));
 assert.ok(raced.result.objects[0].id);assert.equal(await page.getByLabel('记录正文',{exact:true}).inputValue(),'收起以后仍保留的草稿');await page.clock.resume();
 checks.push('External write followed by local draft commit before polling is still consumed, without changing the editor');

 await page.getByRole('button',{name:'记录目录',exact:true}).click();await page.locator('.chronicle-record-row').filter({hasText:'外部工具记事'}).click();await page.waitForFunction(()=>document.querySelector('.map-reader').dataset.view==='reader');await page.locator('.chronicle-prose').filter({hasText:'从模型工具写入北京的记录'}).waitFor();
 let failedRefreshes=0;await page.route('**/api/atlas*',route=>{if(failedRefreshes++===0)return route.abort();return route.continue();});
 const edited=await call('update_entry',{requestId:'external-edit-open-reader',id:entryId,expectedRevision:1,patch:{body:'模型更新后的正文'}});assert.equal(edited.isError,false);await page.locator('.chronicle-prose').filter({hasText:'模型更新后的正文'}).waitFor({timeout:10000});assert.ok(failedRefreshes>=2);await page.unroute('**/api/atlas*');
 checks.push('Failed map refresh keeps the change cursor pending; retry updates the currently read record');
 await page.getByRole('button',{name:'收起记录面板',exact:true}).click();
 await page.getByLabel('搜索地点',{exact:true}).fill('北京');await page.locator('.atlas-search-row>.atlas-button:first-child').first().click();assert.equal(await page.locator('.map-reader').getAttribute('data-view'),'directory');
 await page.locator(`.chronicle-record-row[data-object-id="${entryId}"]`).waitFor();
 await page.getByRole('button',{name:'收起记录面板',exact:true}).click();await page.screenshot({path:path.join(test.output,'map-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(test.output,'map-mobile.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'＋ 记一笔',exact:true}).click();await page.getByLabel('记录正文',{exact:true}).fill('移动视图记录');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 checks.push('Map selection opens filtered directory; selecting a record opens its reader; 390px viewport has no horizontal overflow');
 await page.getByRole('button',{name:'工作空间设置',exact:true}).click();await page.getByRole('heading',{name:'让模型操作史书'}).waitFor();await page.getByRole('button',{name:'复制 MCP 连接配置',exact:true}).click();
 await page.getByLabel('MCP 连接配置').waitFor({state:'visible'});const config=JSON.parse(await page.getByLabel('MCP 连接配置').textContent());assert.equal(config.mcpServers.chronicle.env.CHRONICLE_URL,test.base);assert.ok(path.isAbsolute(config.mcpServers.chronicle.command));assert.equal(JSON.stringify(config).includes(test.token),false);
 checks.push('Settings exposes a usable absolute-path MCP configuration without secrets');
 assert.deepEqual(errors,[]);await writeReport('map-agent-ui.json',{date:new Date().toISOString(),checks,errors,screenshots:test.output});console.log(JSON.stringify({checks,errors,output:test.output},null,2));
}finally{bridge?.stdin.end();bridge?.kill();await browser?.close();await test.app.close();}
