import {createHash} from 'node:crypto';
import {assert, DomainError} from '../../packages/contracts/index.js';
import {parseTime, toRange, formatTime} from '../../features/atlas/time.js';
import {isCustomPlace} from '../../features/atlas/service.js';
import {prepareEntryChange} from '../../features/chronicle/service.js';

export const OPERATION_VERSION = '1';
const string = (maxLength=1000, minLength=0) => ({type:'string',minLength,maxLength});
const integer = (minimum,maximum) => ({type:'integer',minimum,maximum});
const object = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false});
const array = (items,maxItems=100,minItems=0) => ({type:'array',items,minItems,maxItems});
const nullable = schema => ({anyOf:[schema,{type:'null'}]});
const identifier = string(200,1), requestIdentifier=string(180,1);
const bound = object({era:{enum:['CE','BCE']},year:integer(1,100000),month:integer(1,12),day:integer(1,31)},['era','year']);
const timeSpec = object({originalText:string(500),calendar:{enum:['proleptic-gregorian']},kind:{enum:['instant','duration','uncertain','unknown']},precision:{enum:['year','month','day']},approximate:{type:'boolean'},earliest:nullable(bound),latest:nullable(bound)},['originalText','calendar','kind','precision','approximate','earliest','latest']);
const time = {anyOf:[string(500,1),timeSpec,{type:'null'}]};
const coordinate = {type:'array',items:{type:'number'},minItems:2,maxItems:2};
const geometry = {anyOf:[object({type:{enum:['LineString']},coordinates:array(coordinate,10000,2)},['type','coordinates']),object({type:{enum:['Polygon']},coordinates:array(array(coordinate,10000,4),100,1)},['type','coordinates'])]};
const entryFields={title:string(500),body:string(200000,1),kind:{enum:['note','prediction']},status:{enum:['adopted','inbox']},time,placeIds:{...array(identifier,20),uniqueItems:true},conditions:string(20000)};
const pagination={limit:integer(1,100),offset:integer(0,1000000)};
const definitions = [
 ['search_places',true,'按名称或别名查找地点。返回候选及同名歧义；写记录前使用确切 placeId，不根据相似名称猜测。',object({query:string(200,1),country:string(200,1),includeDeleted:{type:'boolean'},...pagination},['query'])],
 ['parse_time',true,'解析日期或时间段，保留原始表达。无法确定的时间不会被补成具体日期。',object({time},['time'])],
 ['list_entries',true,'按文字、地点、类型或收录状态列出记录摘要。每次最多返回100条。',object({query:string(500),placeIds:{...array(identifier,20),uniqueItems:true},kind:{enum:['note','prediction']},status:{enum:['adopted','inbox']},includeDeleted:{type:'boolean'},...pagination})],
 ['get_object',true,'读取一条记录或一个地点的指定版本。长正文分段返回，可用 bodyOffset 继续读取。',object({id:identifier,revision:integer(1,1000000000),includeDeleted:{type:'boolean'},bodyOffset:integer(0,10000000),bodyLimit:integer(1,64000)},['id'])],
 ['create_entry',false,'新增记录。kind 和 status 必须明确；adopted 需要可定位时间和已确认地点。未解决的信息用 inbox 保存，不点亮地图。',object(entryFields,['body','kind','status','time','placeIds'])],
 ['update_entry',false,'修改已有记录的指定字段；必须提供上次读取的 expectedRevision。保留未修改字段、引用和首次预言版本。',object({id:identifier,expectedRevision:integer(1,1000000000),patch:{...object(entryFields),minProperties:1}},['id','expectedRevision','patch'])],
 ['create_place',false,'新增自定义地点。坐标顺序为[经度,纬度]；未知坐标使用null，不推测坐标。',object({name:string(200,1),kind:{enum:['city','settlement','region','naturalFeature','route','custom']},coordinates:nullable(coordinate),aliases:array(string(200,1),100),country:string(200),region:string(200),geometry:nullable(geometry)},['name','kind','coordinates'])],
 ['delete_place',false,'删除指定版本的自定义地点，可恢复。记录正文、地点引用及历史版本保留；内置地名不能删除。',object({id:identifier,expectedRevision:integer(1,1000000000)},['id','expectedRevision'])],
 ['restore_place',false,'恢复已删除的自定义地点；expectedRevision 为其删除后的当前版本。',object({id:identifier,expectedRevision:integer(1,1000000000)},['id','expectedRevision'])],
];
export const OPERATIONS=definitions.map(([name,readOnly,description,inputSchema])=>({name,readOnly,description,inputSchema}));
const byName=new Map(OPERATIONS.map(item=>[item.name,item]));
const canonical=value=>JSON.stringify(sort(value));
function sort(value){if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])]));return value;}
const hash=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value);
const normalize=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en');

/** Validate the same closed schemas that are advertised to tool clients. */
function check(schema,value,field='arguments'){
 const fail=message=>{throw new DomainError('INVALID_INPUT',message,{field});};
 if(schema.anyOf){for(const candidate of schema.anyOf){try{check(candidate,value,field);return;}catch(error){if(!(error instanceof DomainError))throw error;}}fail(`${field} 的格式不符合接口定义。`);}
 if(schema.enum&&!schema.enum.includes(value))fail(`${field} 的取值不在允许范围。`);
 if(schema.type==='null'){if(value!==null)fail(`${field} 必须为 null。`);return;}
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${field} 必须是对象。`);
  const keys=Object.keys(value);for(const key of keys)if(!Object.hasOwn(schema.properties,key))throw new DomainError('INVALID_INPUT',`不支持字段 ${field}.${key}。`,{field:`${field}.${key}`,reason:'UNKNOWN_FIELD'});
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw new DomainError('INVALID_INPUT',`缺少字段 ${field}.${key}。`,{field:`${field}.${key}`,reason:'REQUIRED_FIELD'});
  if(schema.minProperties&&keys.length<schema.minProperties)fail(`${field} 至少需要一项修改。`);
  for(const key of keys)check(schema.properties[key],value[key],`${field}.${key}`);return;
 }
 if(schema.type==='array'){
  if(!Array.isArray(value))fail(`${field} 必须是数组。`);
  if(value.length<(schema.minItems||0)||value.length>schema.maxItems)fail(`${field} 的项目数量不符合限制。`);
  if(schema.uniqueItems&&new Set(value.map(canonical)).size!==value.length)fail(`${field} 不能包含重复项目。`);
  value.forEach((item,index)=>check(schema.items,item,`${field}[${index}]`));return;
 }
 if(schema.type==='string'&&(typeof value!=='string'||value.length<schema.minLength||value.length>schema.maxLength))fail(`${field} 的文字长度不符合限制。`);
 if(schema.type==='boolean'&&typeof value!=='boolean')fail(`${field} 必须是布尔值。`);
 if(['number','integer'].includes(schema.type)&&(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value))||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum)))fail(`${field} 的数字不符合限制。`);
}

function timeResult(value){
 const spec=parseTime(value);
 if(spec.kind==='unknown')assert(spec.earliest===null&&spec.latest===null,'未知时间不能同时含有确定边界。');
 if(spec.kind==='instant')assert(spec.earliest&&spec.latest&&canonical(spec.earliest)===canonical(spec.latest),'单一时间需要相同的开始和结束边界。');
 const range=toRange(spec);
 assert(!['日期无效','开始时间晚于结束时间'].includes(range.reason),range.reason||'日期无效。');
 return {time:spec,label:formatTime(spec),indexed:range.indexed,requiresClarification:!range.indexed,reason:range.reason||null};
}
const aliasesOf=place=>(place.data.aliases||[]).map(alias=>typeof alias==='string'?alias:alias?.name).filter(alias=>typeof alias==='string');
const namesOf=place=>[place.data.name,...aliasesOf(place)].filter(name=>typeof name==='string');
function placeSummary(place){return{id:place.id,revision:place.revision,name:place.data.name,aliases:aliasesOf(place),kind:place.data.kind,country:place.data.country||'',region:place.data.region||'',coordinates:place.data.coordinates||null,custom:isCustomPlace(place),deletedAt:place.deletedAt};}
async function allPlaces(workspace,includeDeleted){
 const items=[];let offset=0;
 while(true){const page=await workspace.list({objectType:'place',includeDeleted,limit:1000,offset});items.push(...page.items);offset+=page.items.length;if(offset>=page.total||!page.items.length)break;}
 return items;
}
function fingerprint(request){return hash(canonical({version:request.version,operation:request.operation,arguments:request.arguments}));}
function changeFromObject(object){return{id:object.id,objectType:object.objectType,expectedRevision:object.revision-1,data:object.data,...(object.data.agentOperation?.deleted===undefined?{}:{deleted:object.data.agentOperation.deleted})};}

/** HTTP auth/origin checks and restore locks belong to the server route. */
export function createOperationsService({getWorkspace,validateCommit}){
 assert(typeof getWorkspace==='function'&&typeof validateCommit==='function','操作服务缺少工作空间或校验入口。');
 function discovery(){
  const operations=clone(OPERATIONS);
  return {version:OPERATION_VERSION,transport:'local-http',executePath:'/api/operations',schemaPath:'/api/operations/schema',authentication:'GET /api/session，再将 token 放入 X-Chronicle-Token 请求头。',operations,
   tools:operations.map(item=>({type:'function',function:{name:item.name,description:item.description,parameters:item.readOnly?item.inputSchema:{...item.inputSchema,properties:{...item.inputSchema.properties,requestId:requestIdentifier},required:[...item.inputSchema.required,'requestId']}}})),
   notes:['function tool 的 requestId 放入执行请求顶层，其余字段放入 arguments。','重试必须使用相同 requestId 和完全相同的参数；修改指令请生成新 requestId。','本机执行器负责调用这些接口；远程模型不能直接访问用户电脑的 127.0.0.1。']};
 }
 async function execute(request){
  check(object({version:{enum:[OPERATION_VERSION]},operation:{enum:OPERATIONS.map(item=>item.name)},arguments:{type:'object',properties:{},additionalProperties:false},requestId:requestIdentifier},['version','operation','arguments']),{...request,arguments:{}} ,'request');
  assert(request&&typeof request==='object'&&request.arguments&&typeof request.arguments==='object'&&!Array.isArray(request.arguments),'arguments 必须是对象。');
  const definition=byName.get(request.operation);check(definition.inputSchema,request.arguments);
  const workspace=getWorkspace(),args=clone(request.arguments),operation=request.operation;
  if(definition.readOnly){assert(request.requestId===undefined,'只读操作不需要 requestId。');return{version:OPERATION_VERSION,operation,result:await read(workspace,operation,args)};}
  check(requestIdentifier,request.requestId,'request.requestId');
  const key=`operation:v1:${request.requestId}`,mark={version:OPERATION_VERSION,requestId:request.requestId,operation,fingerprint:fingerprint(request)};
  // Receipts survive restarts and later edits. Read the saved receipt before
  // validating live names, deleted places, or the caller's now-stale revision.
  const prior=await workspace.getCommit(key);
  if(prior){
   assert(prior.objects.length===1&&prior.objects[0].data.agentOperation?.fingerprint===mark.fingerprint,'这个 requestId 已用于不同指令，请使用新的 requestId。','IDEMPOTENCY_CONFLICT');
   const replay=await workspace.replayCommit({requestId:key,changes:prior.objects.map(changeFromObject)});
   assert(replay,'无法恢复已保存的操作回执。','INVALID_RESPONSE');
   return{version:OPERATION_VERSION,operation,result:replay,replayed:true};
  }
  const changes=await prepare(workspace,operation,args,mark);
  const commit={requestId:key,changes};
  // Handles a duplicate arriving concurrently with the first request.
  const replay=await workspace.replayCommit(commit);
  if(replay)return{version:OPERATION_VERSION,operation,result:replay,replayed:true};
  await validateCommit(workspace,commit);
  return{version:OPERATION_VERSION,operation,result:await workspace.commit(commit),replayed:false};
 }
 return{discovery,execute};
}

async function read(workspace,operation,args){
 if(operation==='parse_time')return timeResult(args.time);
 if(operation==='search_places'){
  const query=normalize(args.query);assert(query,'请输入地点名称。');
  let matches=(await allPlaces(workspace,!!args.includeDeleted)).filter(place=>{const data=place.data;return (!args.country||normalize(data.country||'')===normalize(args.country))&&namesOf(place).some(name=>normalize(name).includes(query));});
  const exact=place=>namesOf(place).some(name=>normalize(name)===query);
  const exactMatches=matches.filter(exact).map(placeSummary);
  matches.sort((a,b)=>Number(exact(b))-Number(exact(a))||a.data.name.localeCompare(b.data.name,'zh-CN')||a.id.localeCompare(b.id));
  const offset=args.offset||0,limit=args.limit||20;
  return{resolution:exactMatches.length>1?'ambiguous_exact':exactMatches.length===1?'unique_exact':matches.length?'candidates':'none',resolvedPlaceId:exactMatches.length===1?exactMatches[0].id:null,exactMatchCount:exactMatches.length,exactMatches:exactMatches.slice(0,100),candidates:matches.slice(offset,offset+limit).map(placeSummary),total:matches.length,offset,limit,nextOffset:offset+limit<matches.length?offset+limit:null};
 }
 if(operation==='list_entries'){
  const limit=args.limit||20,offset=args.offset||0;
  const result=await workspace.list({objectType:'entry',q:args.query||'',placeIds:args.placeIds,kind:args.kind,status:args.status,includeDeleted:!!args.includeDeleted,summary:true,limit,offset});
  return {...result,offset,limit,nextOffset:offset+result.items.length<result.total?offset+result.items.length:null};
 }
 const found=await workspace.get(args.id,{revision:args.revision,includeDeleted:!!args.includeDeleted});
 assert(['entry','place'].includes(found.objectType),'此接口只读取记录和地点。','OPERATION_NOT_ALLOWED');
 const result=clone(found),body=result.data.body||'',offset=args.bodyOffset||0,limit=args.bodyLimit||16000;
 if(typeof result.data.body==='string')result.data.body=body.slice(offset,offset+limit);
 return{object:result,body:{offset,returned:result.data.body?.length||0,total:body.length,nextOffset:offset+limit<body.length?offset+limit:null}};
}

async function prepare(workspace,operation,args,mark){
 const createdId=`${operation==='create_place'?'place':'entry'}_agent_${hash(mark.requestId).slice(0,40)}`;
 if(operation==='create_place')return[{id:createdId,objectType:'place',expectedRevision:0,data:{...args,userCreated:true,agentOperation:mark}}];
 if(operation==='delete_place'||operation==='restore_place'){
  const place=await workspace.get(args.id,{includeDeleted:true});
  assert(isCustomPlace(place),'只能删除或恢复自定义地点，内置地名会继续保留。','OPERATION_NOT_ALLOWED');
  assert(place.revision===args.expectedRevision,'地点已发生变化，请重新读取后再操作。','VERSION_CONFLICT',{id:place.id,expectedRevision:args.expectedRevision,actualRevision:place.revision});
  const deleted=operation==='delete_place';
  assert(deleted?!place.deletedAt:!!place.deletedAt,deleted?'地点已经删除。':'地点尚未删除。','INVALID_STATE');
  return[{id:place.id,objectType:'place',expectedRevision:args.expectedRevision,data:{...place.data,agentOperation:{...mark,deleted}},deleted}];
 }
 let existing=null;
 if(operation==='update_entry'){
  existing=await workspace.get(args.id,{includeDeleted:true});
  assert(existing.objectType==='entry'&&!existing.deletedAt,'只能修改现有记录。','INVALID_STATE');
  assert(existing.revision===args.expectedRevision,'记录已发生变化，请重新读取后再修改。','VERSION_CONFLICT',{id:existing.id,expectedRevision:args.expectedRevision,actualRevision:existing.revision});
 }
 const fields=operation==='update_entry'?args.patch:args;
 const data=existing?clone(existing.data):{title:'',body:'',kind:'note',status:'inbox',occurrenceTime:null,placeRefs:[],citations:[],conditions:''};
 for(const key of ['title','body','kind','status','conditions'])if(Object.hasOwn(fields,key))data[key]=fields[key];
 if(Object.hasOwn(fields,'time'))data.occurrenceTime=timeResult(fields.time).time;
 if(Object.hasOwn(fields,'placeIds')){
  data.placeRefs=[];
  for(const placeId of fields.placeIds){const place=await workspace.get(placeId,{includeDeleted:true});assert(place.objectType==='place'&&!place.deletedAt,'地点不存在或已删除；请重新查找并确认地点。','INVALID_PLACE',{placeId});data.placeRefs.push({placeId,originalName:place.data.name,confirmed:true});}
 }
 const changesPlacement=!existing||['status','time','placeIds'].some(key=>Object.hasOwn(fields,key));
 if(data.status==='adopted'&&changesPlacement){
  const resolved=timeResult(data.occurrenceTime);
  assert(resolved.indexed,'时间还无法定位，请先澄清日期或以 inbox 保存。','TIME_UNRESOLVED',{time:data.occurrenceTime,reason:resolved.reason});
  assert(data.placeRefs.length>0,'请先确认地点，或以 inbox 保存。','PLACE_REQUIRED');
 }
 // Text-only edits preserve the original placement, including UI-created
 // adopted entries with no time/place and deliberately removed place refs.
 data.agentOperation=mark;
 return[prepareEntryChange(data,existing,createdId)];
}
