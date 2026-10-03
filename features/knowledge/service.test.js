import test from 'node:test';
import strict from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {refOf} from '../../packages/contracts/index.js';
import {validateCitation,validateKnowledge,validateDocument,validateSource,validateRelation,prepareRelationChange,relationKey,incomingRefs,referenceStatus,prepareAdoptionChange,prepareUndoChange,outlineOf,reconcileTextBlocks,versionDifference} from './service.js';

const obj=(id,type,data,revision=1)=>({id,objectType:type,revision,data,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',deletedAt:null});
const source=obj('s1','source',{title:'书信',body:'天地玄黄。宇宙洪荒。',format:'text',parseStatus:'ready',attachmentIds:[],citations:[]});
const claim=obj('claim1','knowledge',{kind:'claim',title:'观点',body:'这是我的判断。',citations:[]});
const argument=obj('arg1','knowledge',{kind:'argument',title:'论证',body:'论证内容',premises:['前提甲'],conclusion:'结论',citations:[]});
const concept=obj('concept1','knowledge',{kind:'concept',title:'概念',body:'定义',citations:[]});

test('C08 pinned evidence never resolves to a newer revision, including changed text',()=>{
 const ref={...refOf(source),locator:{start:0,end:5},quote:'天地玄黄。'};
 strict.equal(validateCitation(ref,source).valid,true);
 strict.equal(validateCitation(ref,{...source,revision:2}).valid,false);
 const latest={...source,revision:2,data:{...source.data,body:'修订过的原文'}};
 const status=referenceStatus(ref,source,latest);
 strict.equal(status.valid,true);strict.equal(status.newer,true);strict.equal(status.text,'天地玄黄。');
});
test('A03 and A04 exact source scope, version and original quote are verified',()=>{
 const ref={...refOf(source),locator:{start:5,end:10},quote:'宇宙洪荒。'};
 strict.equal(validateCitation(ref,source,[{sourceId:'s1',revision:1}]).valid,true);
 for(const allowed of [[],[{sourceId:'s2',revision:1}],[{sourceId:'s1',revision:2}]])strict.equal(validateCitation(ref,source,allowed).valid,false);
 strict.equal(validateCitation({...ref,quote:'被改写的原文'},source).valid,false);
 strict.equal(validateCitation({...ref,versionMode:'live',revision:null},source,[{sourceId:'s1',revision:1}]).valid,false);
});
test('Invalid fragments do not silently fall back to a matching whole-body quote',()=>{
 for(const locator of [{start:-1,end:5},{start:5,end:2},{start:0,end:999},{start:0},{start:0,end:0},{page:2},{blockId:'lost'}]){
  strict.equal(validateCitation({...refOf(source),locator,quote:'天地玄黄。'},source).valid,false);
 }
});
test('Document block IDs locate the exact stable paragraph',()=>{
 const doc=obj('doc','document',{body:'一段\n\n二段',blocks:[{id:'para1',kind:'text',body:'一段'},{id:'para2',kind:'text',body:'二段'}],citations:[]});
 strict.equal(validateCitation({...refOf(doc),locator:{blockId:'para2'},quote:'二段'},doc).text,'二段');
 strict.equal(validateCitation({...refOf(doc),locator:{blockId:'para1'},quote:'二段'},doc).valid,false);
});
test('Message reference requires its stable identity, complete status and discussion ID',()=>{
 const message=obj('message1','message',{discussionId:'discussion1',body:'本次推演',status:'complete'});
 const ref={...refOf(message),locator:{discussionId:'discussion1'}};
 strict.equal(validateCitation(ref,message).valid,true);
 strict.equal(validateCitation({...ref,locator:{discussionId:'wrong'}},message).valid,false);
 strict.equal(validateCitation(ref,{...message,data:{...message.data,status:'interrupted'}}).valid,false);
 strict.equal(validateCitation({...ref,targetId:'discussion1'},message).valid,false);
});
test('K04 deleted sources retain verifiable snapshots and recovery status',()=>{
 const deleted={...source,revision:2,deletedAt:'2026-10-02T00:00:00Z'};
 const status=referenceStatus(refOf(source),source,deleted);
 strict.equal(status.valid,true);strict.equal(status.deleted,true);strict.equal(status.newer,true);
 const restored={...deleted,revision:3,deletedAt:null};
 strict.equal(referenceStatus(refOf(source),source,restored).deleted,false);
});
test('K05 unparsed attachment cannot be treated as searchable historical original',()=>{
 const file=obj('file1','source',{body:'图片的描述',format:'attachment',parseStatus:'unparsed',attachmentIds:['att1']});
 strict.equal(validateCitation(refOf(file),file).valid,true);
 strict.equal(validateCitation({...refOf(file),quote:'图片的描述'},file).valid,false);
 strict.equal(validateCitation(refOf(file),file,[{sourceId:file.id,revision:1}]).valid,false);
 strict.throws(()=>validateSource({...file.data,parseStatus:'ready',body:''}),/未转成可检索/);
});
test('K02 relation direction enforces concepts, arguments and prediction targets',()=>{
 const relation=(kind,from,to)=>({kind,from:refOf(from),to:refOf(to),explanation:''});
 strict.doesNotThrow(()=>validateRelation(relation('supports',source,claim),source,claim));
 strict.throws(()=>validateRelation(relation('supports',source,concept),source,concept));
 strict.doesNotThrow(()=>validateRelation(relation('defines',source,concept),source,concept));
 strict.throws(()=>validateRelation(relation('defines',source,claim),source,claim));
 strict.doesNotThrow(()=>validateRelation(relation('premiseOf',claim,argument),claim,argument));
 strict.throws(()=>validateRelation(relation('premiseOf',source,argument),source,argument));
 strict.doesNotThrow(()=>validateRelation(relation('supports',source,obj('prediction','entry',{kind:'prediction',body:'将来'})),source,obj('prediction','entry',{kind:'prediction',body:'将来'})));
});
test('Symmetric relatedTo canonicalization deduplicates and permits cycles without traversal',()=>{
 const data={kind:'relatedTo',from:refOf(claim),to:refOf(source),explanation:''};
 const reverse={...data,from:data.to,to:data.from};
 strict.equal(relationKey(data),relationKey(reverse));
 const existing=prepareRelationChange(data,claim,source);
 strict.throws(()=>prepareRelationChange(reverse,source,claim,[{data:existing.data}]),/已经有/);
 const self={...data,to:refOf(claim)};strict.doesNotThrow(()=>prepareRelationChange(self,claim,claim));
});
test('R07 and K03 incoming references include shared document blocks and reverse relations',()=>{
 const doc1=obj('doc1','document',{body:'',blocks:[{id:'b1',kind:'reference',ref:refOf(claim)}]});
 const doc2=obj('doc2','document',{body:'',blocks:[{id:'b2',kind:'reference',ref:refOf(claim,'live')}]});
 const rel=obj('rel','relation',{kind:'supports',from:refOf(source),to:refOf(claim)});
 const refs=incomingRefs(claim.id,[doc1,doc2,rel]);
 strict.equal(refs.length,3);strict.deepEqual(new Set(refs.map(r=>r.object.id)),new Set(['doc1','doc2','rel']));
 strict.equal(refs[0].ref.targetId,refs[1].ref.targetId);
});
test('K06 adoption preparation is pure and keeps the pinned message lineage',()=>{
 const messageRef={targetId:'m1',versionMode:'pinned',revision:1,locator:{discussionId:'d1'},quote:null};
 const data={kind:'question',title:'新问题',body:'还有什么证据？',citations:[]};
 const result=prepareAdoptionChange({data,messageRef,newId:'k-new'});
 strict.equal(result.id,'k-new');strict.equal(result.expectedRevision,0);strict.deepEqual(result.data.citations,[messageRef]);strict.deepEqual(data.citations,[]);
 strict.throws(()=>prepareAdoptionChange({data,messageRef:{...messageRef,revision:null}}));
 strict.throws(()=>prepareAdoptionChange({data,messageRef,objectType:'entry'}));
});
test('K06 undo protects later edits and restores by a new revision, never overwrites history',()=>{
 const after={...claim,revision:2,data:{...claim.data,body:'采纳后的判断'}};
 const change=prepareUndoChange(after,claim,2);
 strict.equal(change.expectedRevision,2);strict.equal(change.data.body,claim.data.body);strict.equal(change.deleted,false);
 strict.throws(()=>prepareUndoChange({...after,revision:3},claim,2),e=>e.code==='VERSION_CONFLICT');
 strict.equal(prepareUndoChange(after,null,2).deleted,true);
});
test('Text blocks preserve identities across reordering and duplicate paragraphs stay distinct',()=>{
 const original=reconcileTextBlocks('甲\n\n乙\n\n甲');
 strict.notEqual(original[0].id,original[2].id);
 const moved=reconcileTextBlocks('乙\n\n甲\n\n甲\n\n新段',original);
 strict.equal(moved[0].id,original[1].id);strict.equal(moved[1].id,original[0].id);strict.equal(moved[2].id,original[2].id);
 strict.notEqual(moved[3].id,original[0].id);
 const edited=reconcileTextBlocks('甲\n\n乙的修订\n\n甲',original);strict.equal(edited[1].id,original[1].id);
});
test('Outline excludes code fences and version diff keeps exact Chinese changes',()=>{
 strict.deepEqual(outlineOf('# 一\n```md\n# 代码\n```\n## 二').map(v=>v.title),['一','二']);
 const diff=versionDifference(obj('a','document',{body:'我过去认为甲。'}),obj('a','document',{body:'我过去认为乙。'}));
 strict.equal(diff.removed,'甲');strict.equal(diff.added,'乙');
});
test('Business validation rejects missing body, invalid kinds, duplicate paragraphs and unsafe URL',()=>{
 strict.throws(()=>validateKnowledge({kind:'toString',body:'a'}));
 strict.throws(()=>validateKnowledge({kind:'claim',body:''}));
 strict.throws(()=>validateDocument({body:'a',blocks:[{id:'a',kind:'text',body:'b'},{id:'a',kind:'text',body:'c'}]}));
 strict.throws(()=>validateSource({title:'链接',body:'',format:'link',url:'javascript:alert(1)',parseStatus:'unparsed',attachmentIds:[]}));
});
test('Real Workspace integration: pinned evidence, deletion/restore, atomic adoption and revision guarded undo',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'chronicle-knowledge-'));const workspace=new Workspace(directory);
 try{
  await workspace.commit({requestId:'initial',changes:[source,claim].map(o=>({id:o.id,objectType:o.objectType,expectedRevision:0,data:o.data}))});
  const savedSource=await workspace.get(source.id),savedClaim=await workspace.get(claim.id);
  const data={...savedClaim.data,citations:[refOf(savedSource)]};
  await workspace.commit({requestId:'claim-cites',changes:[{id:claim.id,objectType:'knowledge',expectedRevision:1,data}]});
  await workspace.commit({requestId:'revise-source',changes:[{id:source.id,objectType:'source',expectedRevision:1,data:{...source.data,body:'修正后的原文'}}]});
  const cited=await workspace.get(source.id,{revision:1}),latest=await workspace.get(source.id);
  strict.equal(referenceStatus(data.citations[0],cited,latest).newer,true);
  strict.equal(validateCitation(data.citations[0],cited).text,source.data.body);
  await workspace.commit({requestId:'delete-source',changes:[{id:source.id,objectType:'source',expectedRevision:2,data:latest.data,deleted:true}]});
  strict.equal(referenceStatus(data.citations[0],cited,await workspace.get(source.id,{includeDeleted:true})).deleted,true);
  strict.equal((await workspace.get(claim.id)).data.citations[0].revision,1);
  const messageRef={targetId:'m1',versionMode:'pinned',revision:1,locator:{discussionId:'d1'},quote:null};
  const before=await workspace.get(claim.id);
  const adopted=prepareAdoptionChange({target:before,data:{...before.data,body:'与人物讨论后的判断'},messageRef});
  const commit=await workspace.commit({requestId:'adopt',changes:[adopted]});
  strict.equal((await workspace.commit({requestId:'adopt',changes:[adopted]})).commitId,commit.commitId);
  const current=await workspace.get(claim.id);const undo=prepareUndoChange(current,before,current.revision);
  await workspace.commit({requestId:'undo',changes:[undo]});
  strict.equal((await workspace.get(claim.id)).data.body,before.data.body);
  strict.equal((await workspace.history(claim.id)).length,4);
 }finally{workspace.close();const resolved=path.resolve(directory);strict.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep));rmSync(resolved,{recursive:true,force:true});}
});
