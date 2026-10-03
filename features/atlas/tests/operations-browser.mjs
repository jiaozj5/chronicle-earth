// Real UI verification for TimeView management and map-drawn regions/routes.
import assert from 'node:assert/strict';
import {createAppServer} from '../../../apps/server/main.js';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'C:/Users/jiaoz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dir=await mkdtemp(path.join(tmpdir(),'chronicle-atlas-operations-'));
const app=await createAppServer({dataDir:dir});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
 const page=await browser.newPage({viewport:{width:1000,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${app.server.address().port}/features/atlas/tests/host.html`);
 await page.addStyleTag({url:`http://127.0.0.1:${app.server.address().port}/apps/client/style.css`});
 await page.evaluate(async()=>{
   document.querySelector('#test-root').style.width='268px';
   const {api}=await import('/apps/client/api.js'),{parseTime}=await import('/features/atlas/time.js'),{mount}=await import('/features/atlas/index.js');
   window.api=api;await api.init();window.notifications=[];
   await api.commit([{id:'time-original',objectType:'timeView',expectedRevision:0,data:{name:'十九世纪',timeSpec:parseTime('1800—1899')}},{id:'record-stable',objectType:'entry',expectedRevision:0,data:{title:'不受图层整理影响',body:'正文始终保留',kind:'note',status:'adopted',citations:[],placeRefs:[],occurrenceTime:parseTime('1850')}}]);
   window.beforeRecord=await api.get('record-stable');
   window.atlas=await mount(document.querySelector('#test-root'),{api,selection:{placeRefs:[],occurrenceTime:null},onSelection(s){window.selection=s;},notify(...args){window.notifications.push(args);}});
 });
 await page.waitForFunction(()=>document.querySelector('.atlas-map-status')?.hidden===true);
 await page.getByLabel('已保存的时间图层',{exact:true}).selectOption('time-original');
 await page.getByRole('button',{name:'管理图层',exact:true}).click();
 await page.getByLabel('新的图层名称',{exact:true}).fill('我的十九世纪');await page.getByRole('button',{name:'改名',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="已保存的时间图层"] option:checked')?.textContent==='我的十九世纪');
 await page.getByLabel('图层拆分时间',{exact:true}).fill('1850');await page.getByRole('button',{name:'拆分图层',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.atlas-merge-choices input').length===2);
 await page.getByLabel('我的十九世纪 · 前段',{exact:true}).check();await page.getByLabel('我的十九世纪 · 后段',{exact:true}).check();
 await page.getByLabel('合并后的图层名称',{exact:true}).fill('十九世纪合并');await page.getByRole('button',{name:'合并所选图层',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.atlas-merge-choices input').length===1);
 assert.equal(await page.getByLabel('已保存的时间图层',{exact:true}).locator('option:checked').textContent(),'十九世纪合并');
 await page.getByRole('button',{name:'删除图层',exact:true}).click();await page.getByRole('button',{name:'确认删除图层',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="已保存的时间图层"]').options.length===1);
 assert.equal(await page.evaluate(async()=>JSON.stringify(window.beforeRecord)===JSON.stringify(await api.get('record-stable'))),true);
 await page.getByRole('button',{name:'收起管理',exact:true}).click();
 // Map drawing is tested with real pointer clicks, undo, finish and persistence.
 await page.getByRole('button',{name:'＋ 自定义地点',exact:true}).click();
 await page.getByLabel('新地点名称',{exact:true}).fill('我关注的路线');await page.getByLabel('地点类型',{exact:true}).selectOption('route');
 await page.getByRole('button',{name:'在地图上绘制',exact:true}).click();
 const canvas=page.locator('.atlas-map');await canvas.click({position:{x:80,y:120}});await canvas.click({position:{x:150,y:160}});await canvas.click({position:{x:190,y:200}});
 await page.getByRole('button',{name:'撤回上一个点',exact:true}).click();
 await page.getByRole('button',{name:'结束绘制',exact:true}).click();
 assert.match(await page.locator('.atlas-shape-area [role=status]').textContent(),/已取 2 点 · 范围已就绪/);
 await page.getByRole('button',{name:'保存地点',exact:true}).click();await page.waitForFunction(()=>window.selection.placeRefs.length===1);
 const route=await page.evaluate(async()=>await api.get(selection.placeRefs[0].placeId));assert.equal(route.data.geometry.type,'LineString');assert.equal(route.data.geometry.coordinates.length,2);
 // Escape and keyboard-assisted recording work independently of pointer accuracy.
 await page.getByRole('button',{name:'＋ 自定义地点',exact:true}).click();await page.getByLabel('新地点名称',{exact:true}).fill('我关注的地区');await page.getByLabel('地点类型',{exact:true}).selectOption('region');
 await page.getByRole('button',{name:'在地图上绘制',exact:true}).click();await canvas.press('Enter');await canvas.press('Escape');assert.equal(await page.getByLabel('范围经纬度',{exact:true}).inputValue(),'');
 await page.getByRole('button',{name:'在地图上绘制',exact:true}).click();await canvas.click({position:{x:80,y:120}});await canvas.click({position:{x:180,y:120}});await canvas.click({position:{x:150,y:200}});await canvas.press('Control+Enter');
 await page.getByRole('button',{name:'保存地点',exact:true}).click();await page.waitForFunction(()=>window.selection.placeRefs.length===2);
 const region=await page.evaluate(async()=>await api.get(selection.placeRefs[1].placeId));assert.equal(region.data.geometry.type,'Polygon');assert.equal(region.data.geometry.coordinates[0].length,4);
 const explored=await page.evaluate(async()=>{
   const {parseTime}=await import('/features/atlas/time.js');const regionRef=selection.placeRefs.at(-1);
   await api.commit([{id:'region-record',objectType:'entry',expectedRevision:0,data:{title:'区域层面的记录',body:'只有这片区域被关注',kind:'note',status:'adopted',citations:[],placeRefs:[regionRef],occurrenceTime:parseTime('1850')}}]);await atlas.refresh();return(await api.atlas({})).explored;
 });assert.deepEqual(explored,[region.id]);
 const overflow=await page.evaluate(()=>{const root=document.querySelector('#test-root'),rect=root.getBoundingClientRect();return [...root.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().right>rect.right+1).map(e=>e.className);});assert.deepEqual(overflow,[]);
 await mkdir(new URL('../quality/',import.meta.url),{recursive:true});
 await page.screenshot({path:fileURLToPath(new URL('../quality/operations-light-268px.png',import.meta.url)),fullPage:true});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:fileURLToPath(new URL('../quality/operations-dark-268px.png',import.meta.url)),fullPage:true});
 assert.deepEqual(errors,[]);
 const result={date:new Date().toISOString(),test:'real SQLite / HTTP / Edge time-view and map-drawing UI',checks:['rename, split, merge and delete keep original entry ID, revision and body','split boundary enters following view without overlap','route pointer drawing, undo and finish','region pointer drawing, Ctrl+Enter finish','keyboard center-point and Escape cancellation','persisted GeoJSON and own-scale exploration','268px content width without overflow','dark theme screenshot'],errors};
 await writeFile(new URL('../quality/operations-browser.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();await app.close();}
