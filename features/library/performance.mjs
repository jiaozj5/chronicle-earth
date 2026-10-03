import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {testServer} from '../../tests/fixtures/harness.mjs';
import {PROFILE,normalizeBlock,quoteTarget} from './model.js';

const{app,output}=await testServer('library-scale',{seed:false});
const timed=async fn=>{const start=performance.now();const value=await fn();return{ms:performance.now()-start,value};};
try{
 const pages=Array.from({length:500},(_,index)=>({index,label:String(index+1),width:720,height:1000,status:'ready',warnings:[]}));
 const blocks=pages.flatMap(p=>Array.from({length:10},(_,n)=>normalizeBlock({id:`b-${p.index}-${n}`,pageIndex:p.index,text:`第 ${p.index+1} 页，第 ${n+1} 段。材料、理解与证据都有自己的位置。`.repeat(8)})));
 const doc={profile:PROFILE,renditionId:'scale-rendition',engine:'synthetic',pages,blocks},asset=app.workspace.putAttachment(Buffer.from(JSON.stringify(doc)),{name:'scale.json',mime:'application/json'}),publicationId='scale-book';
 app.workspace.commit({requestId:'scale-seed',changes:[{id:'scale-source',objectType:'source',expectedRevision:0,data:{title:'规模测试',body:'合成资料',format:'text'}},{id:publicationId,objectType:'publication',expectedRevision:0,data:{title:'500 页合成藏书',sourceId:'scale-source',currentRendition:doc.renditionId,renditions:[{id:doc.renditionId,structureAttachmentId:asset.id,attachmentIds:[asset.id]}],attachmentIds:[asset.id]}}]});
 let request=0;const call=(name,args)=>app.library.call(name,args),write=(name,args)=>call(name,{...args,requestId:'scale-'+ ++request});
 const imported=await timed(async()=>{for(let batch=0;batch<10;batch++)await write('annotation_import',{publicationId,annotations:Array.from({length:1000},(_,i)=>{const b=blocks[(batch*1000+i)%blocks.length];return{'cr:profile':PROFILE,'cr:renditionId':doc.renditionId,'cr:targets':[quoteTarget(b,0,5)],'cr:mark':{type:'highlight',color:'#cc8844'},body:{value:'可追溯批注 '+(batch*1000+i)}};})});});
 const measurements={};for(const[name,args]of [['book_outline',{publicationId}],['book_read',{publicationId,pageIndex:250}],['annotation_list',{publicationId,pageIndex:250}],['book_search',{publicationId,query:'证据'}]]){const times=[];for(let i=0;i<20;i++)times.push((await timed(()=>call(name,args))).ms);times.sort((a,b)=>a-b);measurements[name]={p50Ms:times[9],p95Ms:times[18],maxMs:times[19]};}
 assert.equal((await call('annotation_list',{publicationId,pageIndex:250})).total,20);
 const single=await timed(()=>write('annotation_create',{publicationId,renditionId:doc.renditionId,targets:[quoteTarget(blocks[0],0,5)],mark:{type:'check',color:'#cc8844'}}));
 const exported=await timed(()=>write('book_export',{publicationId}));const report={date:new Date().toISOString(),dataset:{pages:500,blocks:5000,annotations:10000,kind:'synthetic text; excludes OCR conversion and browser interaction'},node:process.version,output,bulkImportMs:imported.ms,measurements,singleAnnotationSaveMs:single.ms,exportMs:exported.ms,exportBytes:app.workspace.getAttachment(exported.value.attachmentId).size};
 await mkdir('quality',{recursive:true});await writeFile('quality/library-performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await app.close();}
