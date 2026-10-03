import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReadingProviders} from './reading-providers.js';
import {normalizeArkEndpoint} from './doubao-provider.js';

test('model catalog and per-request choices validate capabilities; keys stay server-side and survive restart',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'reading-models-'));t.after(()=>{assert.ok(directory.startsWith(path.resolve(tmpdir())+path.sep));rmSync(directory,{recursive:true,force:true});});let selected;
 const codex={models:async()=>[{id:'available-model',label:'模型 A',vision:false,reasoningEfforts:['low','high'],defaultReasoningEffort:'low'}],status:async()=>({connected:true}),generate:async a=>{selected=a;return{body:'real adapter test'};}};
 const registry=await createReadingProviders({directory,codex});const models=[{id:'ep-user-model',label:'我的豆包',vision:true,tools:true}];
 const result=await registry.configure({endpoint:'https://ark.cn-beijing.volces.com/api/v3',apiKey:'test-secret-never-return',models});assert.equal(result.hasApiKey,true);assert.equal(JSON.stringify(result).includes('test-secret'),false);
 const catalog=await registry.catalog();assert.equal(catalog.models.length,2);assert.equal(JSON.stringify(catalog).includes('test-secret'),false);
 const choice=await registry.resolve({provider:'codex',model:'available-model',effort:'high'});await choice.generate({prompt:'问题'});assert.equal(selected.model,'available-model');assert.equal(selected.effort,'high');assert.equal(choice.vision,false);
 await assert.rejects(registry.resolve({provider:'codex',model:'nonexistent'}));await assert.rejects(registry.resolve({provider:'codex',model:'available-model',effort:'ultra'}));
 const reopened=await createReadingProviders({directory,codex});assert.equal(reopened.settings().hasApiKey,true);assert.equal((await reopened.resolve({provider:'doubao',model:'ep-user-model'})).label,'我的豆包');
 await assert.rejects(registry.configure({endpoint:'https://ark.cn-shanghai.volces.com/api/v3',models}));await registry.configure({models,apiKey:''});assert.equal(registry.settings().hasApiKey,false);
});
test('Doubao URL normalization preserves v3 and rejects redirects, credentials, query secrets and unrelated hosts',()=>{
 assert.equal(normalizeArkEndpoint('https://ark.cn-beijing.volces.com/api/v3/'),'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
 for(const url of ['http://ark.cn-beijing.volces.com/api/v3','https://example.com/api/v3','https://ark.cn-beijing.volces.com.evil.test/api/v3','https://user:key@ark.cn-beijing.volces.com/api/v3','https://ark.cn-beijing.volces.com/api/v3?key=secret'])assert.throws(()=>normalizeArkEndpoint(url));
});
