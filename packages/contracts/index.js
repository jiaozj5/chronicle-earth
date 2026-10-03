export const CONTRACT_VERSION = '1.0';
export const OBJECT_TYPES = ['entry','draft','place','timeView','knowledge','document','source','citation','relation','persona','discussion','message','predictionReview','adoption','publication','annotation','importJob','libraryOperation'];
export class DomainError extends Error { constructor(code,message,details={}){super(message);this.name='DomainError';this.code=code;this.details=details;} }
export function id(prefix='obj'){return prefix+'_'+globalThis.crypto.randomUUID();}
export function assert(value,message,code='INVALID_INPUT',details={}){if(!value)throw new DomainError(code,message,details);}
export function titleOf(object){const d=object?.data||{};return d.title||d.name||d.body?.split('\n').find(s=>s.trim())?.slice(0,70)||'未命名';}
export function refOf(object,versionMode='pinned'){return{targetId:object.id,versionMode,revision:versionMode==='pinned'?object.revision:null,locator:null,quote:null};}
export function validateChange(change){assert(change&&typeof change.id==='string'&&change.id.length>0&&change.id.length<200,'内容标识无效');assert(OBJECT_TYPES.includes(change.objectType),'内容类型无效');assert(Number.isInteger(change.expectedRevision)&&change.expectedRevision>=0,'缺少期望版本');assert(change.data&&typeof change.data==='object'&&!Array.isArray(change.data),'内容格式无效');}
export function changeFor(object,data=object.data,extra={}){return{id:object.id,objectType:object.objectType,expectedRevision:object.revision,data,...extra};}
export function createChange(objectType,data,newId=id(objectType)){return{id:newId,objectType,expectedRevision:0,data};}
export const RELATION_TYPES={supports:'支持',refutes:'质疑',defines:'定义',premiseOf:'作为前提',exampleOf:'作为实例',relatedTo:'相关'};
export const TYPE_LABELS={entry:'记录',draft:'草稿',place:'地点',timeView:'时间图层',knowledge:'知识项',document:'文稿',source:'材料',persona:'人物',discussion:'讨论',message:'消息',predictionReview:'预言复盘',relation:'关系',citation:'引用',adoption:'采纳',publication:'藏书',annotation:'批注',importJob:'转换任务',libraryOperation:'藏书操作'};
