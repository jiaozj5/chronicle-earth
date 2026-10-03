import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {testServer,browserEngine} from '../tests/fixtures/harness.mjs';

const {app,request,base,output}=await testServer('shell');let browser;const errors=[],passed=[];
try{
 const changes=[
  {id:'shell_source',objectType:'source',expectedRevision:0,data:{title:'壳层试验的来源',body:'固定版本一的原始文字。',format:'text',parseStatus:'ready',attachmentIds:[],citations:[]}},
  {id:'shell_knowledge',objectType:'knowledge',expectedRevision:0,data:{title:'壳层试验的观点',body:'这里是跨目录可搜索的个人解释。',kind:'claim',citations:[]}}
 ];
 await request('/api/commit',{requestId:'shell_sources',changes});
 const playwright=await browserEngine();browser=await playwright.chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('.chronicle-root').waitFor({state:'attached'});
 await page.keyboard.press('Control+k');assert.equal(await page.getByRole('searchbox',{name:'全局搜索',exact:true}).evaluate(e=>e===document.activeElement),true);
 await page.keyboard.type('shell');await page.getByRole('searchbox',{name:'全局搜索',exact:true}).fill('壳层试验');await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'查找整个工作空间'});await dialog.waitFor();await dialog.getByRole('button',{name:'材料 壳层试验的来源',exact:true}).click();await page.locator('.kn-detail').getByText('固定版本一的原始文字。',{exact:true}).waitFor();passed.push('Ctrl+K targets global search; mixed-type results navigate to exact source.');
 const source=app.workspace.get('shell_source');await request('/api/commit',{requestId:'shell_source_v2',changes:[{id:source.id,objectType:'source',expectedRevision:source.revision,data:{...source.data,body:'第二版已经改变的文字。'}}]});
 await page.goto(base+'/#sources?id=shell_source&revision=1');await page.locator('.kn-detail').getByText('固定版本一的原始文字。',{exact:true}).waitFor();await page.reload();await page.locator('.kn-detail').getByText('固定版本一的原始文字。',{exact:true}).waitFor();passed.push('Pinned revision in the URL survives full browser reload after source changes.');
 await page.getByRole('button',{name:'工作空间设置',exact:true}).click();await page.getByRole('textbox',{name:'模型服务地址',exact:true}).fill('https://example.invalid/v1');await page.getByRole('textbox',{name:'模型名称',exact:true}).fill('later');await page.getByRole('textbox',{name:'模型服务密钥',exact:true}).fill('shell-test-secret');await page.getByRole('button',{name:'保存连接设置',exact:true}).click();await page.getByText('连接设置已保存，讨论时会显示使用的材料范围。',{exact:true}).waitFor();assert.equal((await request('/api/settings')).hasApiKey,true);
 await page.getByRole('checkbox',{name:'清除已保存密钥',exact:true}).check();await page.getByRole('button',{name:'保存连接设置',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('input[aria-label="清除已保存密钥"]').checked);const setting=await request('/api/settings');assert.equal(setting.hasApiKey,false);assert.equal(JSON.stringify(setting).includes('shell-test-secret'),false);passed.push('Model connection can be saved and cleared without exposing its secret.');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出完整备份',exact:true}).click();await download;await page.getByRole('link',{name:'下载备份',exact:true}).waitFor();passed.push('Settings export produces a real downloadable complete backup.');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed,errors,output},null,2));
}finally{await writeFile(path.join(output,'report.json'),JSON.stringify({passed,errors},null,2));await browser?.close();await app.close();}
