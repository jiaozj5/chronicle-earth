import {LIBRARY_TOOLS} from './schema.js';
import {AGENT_INSTRUCTIONS} from './agent-guide.js';
export function libraryOpenApi(base){
 return{openapi:'3.1.0',info:{title:'岁月史书 · 外部图书 Agent',version:'1.0.0',description:AGENT_INSTRUCTIONS},servers:[{url:base}],security:[{localSession:[]}],components:{securitySchemes:{localSession:{type:'apiKey',in:'header',name:'X-Chronicle-Token',description:'本机执行器从 GET /api/session 取得；不传给模型。'}}},paths:Object.fromEntries(LIBRARY_TOOLS.filter(t=>t.name!=='reader_sync').map(t=>['/api/library/tools/'+t.name,{post:{operationId:t.name,summary:t.description,requestBody:{required:true,content:{'application/json':{schema:t.inputSchema}}},responses:{200:{description:'领域操作结果；界面命令须核对 commandStatus。',content:{'application/json':{schema:{type:'object'}}}},default:{description:'未确认成功；读取 error.code/message/details 并按 Agent 使用说明处理。'}}}}]))};
}
