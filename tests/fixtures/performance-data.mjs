import {createChange} from '../../packages/contracts/index.js';
import {parseTime} from '../../features/atlas/time.js';
import {createHash} from 'node:crypto';
const bodyBytes=(bytes,label)=>label+'\n'+('Synthetic fixture paragraph: cities, memory, rivers and evidence. ').repeat(Math.ceil(bytes/64)).slice(0,bytes-Buffer.byteLength(label)-1);
export const shape={entries:10000,normalBodyTargetBytes:2048,longEntries:100,longBodyTargetBytes:102400,places:500,timeViews:100,documents:20,knowledge:2000,relations:20000,sources:100,sourceTextTargetMiB:50,personas:20,revisionsPerObject:3,attachments:100,attachmentMiB:500};
export async function seedPerformance(workspace,{onProgress=()=>{}}={}){
 const changes=[],attachments=[];const time=parseTime('1850—1860');
 for(let i=0;i<500;i++)changes.push(createChange('place',{name:'验收城市'+i,kind:i===498?'region':i===499?'route':'city',aliases:i===0?['历史城名']:[],coordinates:[70+(i%100)*.7,15+Math.floor(i/100)*2]},'perf_place_'+i));
 for(let i=0;i<100;i++)changes.push(createChange('timeView',{name:'时间图层'+i,time:parseTime(String(1800+i)),timeSpec:parseTime(String(1800+i)),occurrenceTime:parseTime(String(1800+i))},'perf_time_'+i));
 for(let i=0;i<10000;i++)changes.push(createChange('entry',{title:(i<100?'长文-':'普通-')+String(i).padStart(5,'0'),body:bodyBytes(i<100?102400:2048,'合成验收记录'+i+' 河流'),kind:i%10===0?'prediction':'note',initialPredictionRevision:i%10===0?1:undefined,status:'adopted',occurrenceTime:i%97===0?null:time,placeRefs:i%89===0?[]:[{placeId:'perf_place_'+(i%500),confirmed:true},...(i%37===0?[{placeId:'perf_place_'+((i+1)%500),confirmed:true}]:[])],citations:[]},'perf_entry_'+i));
 for(let i=0;i<2000;i++)changes.push(createChange('knowledge',{title:'观点'+i,body:'每一个观点可以由材料支持，也允许有反例。',kind:'claim',citations:[{targetId:'perf_entry_'+i,versionMode:'pinned',revision:1,locator:null,quote:null}]},'perf_knowledge_'+i));
 for(let i=0;i<20;i++)changes.push(createChange('document',{title:'体系文稿'+i,body:'# 体系\n\n正文可以独立编辑。\n\n| 概念 | 说明 |\n| --- | --- |\n| 地方 | 多尺度 |\n\n$$a^2+b^2=c^2$$',blocks:[{id:'block_'+i,kind:'text',body:'正文可以独立编辑。'},{id:'ref_'+i,kind:'reference',ref:{targetId:'perf_knowledge_'+i,versionMode:'pinned',revision:1}}],citations:[]},'perf_document_'+i));
 for(let i=0;i<20000;i++)changes.push(createChange('relation',{kind:'supports',from:{targetId:i<10000?'perf_entry_'+i:'perf_knowledge_'+(i%2000),versionMode:'pinned',revision:1},to:{targetId:'perf_knowledge_'+((i+1)%2000),versionMode:'pinned',revision:1},explanation:'合成数据中的显式关联'},'perf_relation_'+i));
 for(let i=0;i<100;i++){
  const buffer=Buffer.alloc(5*1024*1024,i);buffer.write('附件 '+i+' 独立实际内容摘要');const attachment=workspace.putAttachment(buffer,{name:'中文长文件名-完整备份验收-附件-'+i+'.bin',mime:'application/octet-stream'});attachments.push({...attachment,expectedHash:createHash('sha256').update(buffer).digest('hex')});
  changes.push(createChange('source',{title:'可检索来源'+i,body:bodyBytes(524288,'合成来源'+i+' 证据范围'),format:'text',parseStatus:'ready',attachmentIds:[attachment.id],citations:[]},'perf_source_'+i));
  if(i%10===9){onProgress({phase:'attachments',completed:i+1,total:100});await new Promise(r=>setImmediate(r));}
 }
 for(let i=0;i<20;i++)changes.push(createChange('persona',{name:'资料人物'+i,style:'清楚',interpretation:'合成验收人物',sourceIds:['perf_source_'+i,'perf_source_'+((i+1)%100)]},'perf_persona_'+i));
 let saved=0;
 for(let revision=0;revision<3;revision++)for(let offset=0;offset<changes.length;offset+=100){const batch=changes.slice(offset,offset+100).map(change=>({...change,expectedRevision:revision,data:{...change.data,fixtureRevision:revision+1}}));workspace.commit({requestId:'perf_seed_'+revision+'_'+offset,changes:batch});saved+=batch.length;if(offset%1000===0){onProgress({phase:'revisions',completed:saved,total:changes.length*3});await new Promise(r=>setImmediate(r));}}
 return{shape,objects:changes.length,revisions:changes.length*3,attachments};
}
