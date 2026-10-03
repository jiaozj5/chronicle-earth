# 实现契约 1.0

通用对象 `{id, objectType, revision, createdAt, updatedAt, deletedAt, data}`。所有模块使用 data 中的业务字段。代码采用原生 JavaScript ESM，Node 24+；浏览器可直接导入共享契约。无构建步骤，无前端框架依赖。单元测试用 node:test。

## Workspace 接口

`new Workspace(directory)` 来自 packages/workspace/index.js。同步 SQLite 可用；方法即使同步，调用端统一 await。

- `commit({requestId, changes})` → `{commitId, sequence, objects}`。change 为 `{id,objectType,expectedRevision,data,deleted?:boolean}`；创建 expectedRevision=0。更新必须传完整 data。delete/restore 为 revision 变更。原子、幂等、冲突保护。返回 objects 是提交后的对象。
- `get(id, {revision?,includeDeleted?}={})` → object 或抛 DomainError。
- `list({objectType?,objectTypes?,q?,includeDeleted?,onlyDeleted?,limit=50,offset=0,ids?,summary?}={})` → `{items,total,sequence,indexedThroughSequence}`。limit 上限至少允许 100000；服务内 Atlas 使用全量 metadata，不将全部正文传浏览器。
- `history(id)` → 修订对象数组，新版本在前。
- `searchSourceVersions(sourceRefs,query,{limit=8}={})` → `{items:[{sourceId,revision,title,text,locator}],sequence}`；sourceRefs 精确 `{sourceId,revision}`；不扩范围。
- `putAttachment(buffer,{name,mime})` → `{id,name,mime,size,sha256}`；`getAttachment(id)` → `{buffer,name,mime,size,sha256}`。
- `exportBackup(destinationFile)` → `{path,objects,attachments}`；`importBackup(sourceFile)` 只能导入到空数据库；包格式由 A1 定义并保证完整性。可提供额外 API，但须沟通。
- `stats()` → `{sequence,counts,workspaceId}`；`close()`。错误使用共享 DomainError。

## 业务字段

- Entry/Draft：`{title,body,kind:'note'|'prediction',status:'adopted'|'inbox',occurrenceTime:TimeSpec|null,placeRefs:[{placeId,originalName?,confirmed:true}],citations:[],conditions?:string,initialPredictionRevision?:number}`。Draft 另有 editingId、editingRevision；提交正式记录和删除对应 Draft 同一事务。
- Place：`{name,kind:'city'|'settlement'|'region'|'naturalFeature'|'route'|'custom',aliases:[string或{name,...}],coordinates:[lon,lat]|null,geometry?:GeoJSON,originalName?}`。
- TimeSpec：`{originalText,calendar:'proleptic-gregorian',kind:'instant'|'duration'|'uncertain'|'unknown',precision:'year'|'month'|'day',approximate:boolean,earliest:DateBound|null,latest:DateBound|null}`。DateBound `{era:'CE'|'BCE',year,month?,day?}`。由 A3 的时间模块处理，禁止各模块自行比较时间文本。
- Knowledge：`{title,body,kind:'concept'|'claim'|'question'|'argument',citations:[],premises?:[],conclusion?:string}`。
- Document：`{title,body,blocks:[{id,kind:'text'|'reference',body?,ref?}],citations:[]}`。正文可为 Markdown，目录从标题提取；引用块有稳定 ID。
- Source：`{title,body,format:'text'|'markdown'|'link'|'attachment',url?,author?,attachmentIds:[],parseStatus:'ready'|'unparsed',citations:[]}`。
- Citation ref：`{targetId,versionMode:'live'|'pinned',revision:number|null,locator:null|{start?,end?,blockId?,discussionId?,page?},quote:string|null}`。
- Relation：`{kind,from:ref,to:ref,explanation}`；Citation 对象可用 `{fromId,ref}`。
- Persona：`{name,title?,body?,style,interpretation,sourceIds:[],avatarAttachmentId?}`。
- Discussion：`{title,personaId,sourceRefs:[{sourceId,revision}],contextRefs:[],status}`。
- Message：`{discussionId,role:'user'|'assistant',body,status:'complete'|'interrupted'|'failed',citations:[],contentKind:'user'|'interpretation'|'inference',contextSnapshot?}`。
- PredictionReview：`{predictionRef,status:'pending'|'supported'|'partlySupported'|'notSupported'|'indeterminate',body}`。
- Adoption：`{messageRef,targetRefs:[],changes:[{id,before,afterRevision}],status:'active'|'undone'}`。创建回执与目标对象一次提交，撤销检查当前版本。

## 浏览器 API 与模块挂载

应用壳提供 `ctx.api`：`list(query)`, `get(id, options)`, `history(id)`, `commit(changes,requestId?)`, `remove(object)`, `restore(object)`, `upload(file)`, `stats()`；与 Workspace 返回值一致。HTTP /api/objects、/api/objects/:id、/api/objects/:id/history、/api/commit、/api/attachments；统一 JSON 错误 `{error:{code,message,details}}`。

`ctx.navigate(route,params={})`，route 为 chronicle/knowledge/sources/personas/settings；`ctx.openObject(id,revision?)`；`ctx.notify(message,tone?)`；`ctx.refresh()`；`ctx.selection={placeRefs:[],occurrenceTime:null}`。模块不得私改共享上下文，通知变化使用回调。

前端模块 `export async function mount(container,ctx)`，返回 `{dispose?,refresh?,newEntry?,open?,setContext?}`。模块维护局部状态，切换前 dispose 允许 await。代码在各自目录的 index.js 与 style.css；服务/纯逻辑另置 service.js、time.js。禁止内联用户 HTML，使用 textContent 或受控 Markdown 渲染。

- A2 mount 收到 `ctx.params={objectId?,revision?,filter?,newEntry?}`；`ctx.onDiscuss(ref)`、`ctx.onDevelop(ref)` 来自壳；setContext 接收最新 selection，但不得改变已开始草稿。
- A3 mount 收到 `ctx.onSelection(selection)`；导出 time.js 的 `parseTime(text)`, `toRange(spec)`, `overlaps(a,b)`, `formatTime(spec)`；导出 service.js 的 `projectAtlas(entries,places,timeSpec)` 返回 `{markers,total,explored}`，并实现必要补充能力。
- A4 mount 收到 `ctx.params={objectId?,revision?,seedRefs?,mode?}`，sources 路由 mode=sources。暴露 service.js 的纯 `validateCitation(ref,object,allowedSourceRefs?)`，及必要准备变更 API。
- A5 mount 收到 `ctx.params={contextRefs?,personaId?}`；调用 ctx.api.personaRequest(path,body,signal?) 访问 /api/personas/*，服务端暴露 `handleRequest(path,body,{workspace,settings,signal,...})`，结果/错误使用统一结构。A0 集成其路由。不能使用 Codex 会话凭据或假造人物回复。

通用 UI 位于 packages/ui/index.js，由 A0 提供 `el(tag,attrs,...children)`, `button(label,onClick,className?)`, `field(label,input)`, `formatDate`, `renderMarkdown`。模块可用原生 DOM 自行创建局部控件。全局 CSS 由 A0 维护；模块样式加各自类名前缀。

共享接口修改先通知 A0；各智能体只写拥有的目录。API 不全时可建立局部契约测试，不静默创建第二个存储层。
# 集成补充（2026-10-01）

- `Workspace.replayCommit({requestId,changes})`：读取已经持久化的原始回执；载荷不同时抛 `IDEMPOTENCY_CONFLICT`，没有历史请求返回 null。HTTP 在领域校验之前检查重放，避免后来变化的 live 引用阻断已成功请求的恢复。A0 在集成期间补充该接口，存储仍归 A1。
- `Draft.data.draftKind`：`chronicle`（兼容未设置的旧史书草稿）、`knowledge`、`sources`。云上草稿另含 `targetType`、`editingId`、`editingRevision`、`content`；正文和标题用于检索。`api.list` 的 `draftKind` 在分页前筛选。
- 普通 `/api/commit` 必须经过领域校验，禁止直接创建或改写讨论消息、讨论上下文和采纳回执。人物服务负责这些对象的稳定身份与冻结范围。
- 更新现有目标的 `/api/adopt` 必须提供 `targetRevision`；目标改变时返回冲突。采纳消息必须是完成的 assistant 回复。撤销走领域准备函数和单次原子提交，重复撤销不会再次改写目标。
- 备份 export/import 可以附 `transferId`，通过 `/api/backup/progress/:id` 查看实际字节、修订和阶段进度。恢复与其他写入/讨论互斥，阅读可以继续。
- 挂载模块提供 `getNavigationState()`，由壳在 `dispose()` 成功后读取，记录当前内容/草稿/固定版本及局部阅读状态；返回时不能再次执行最初的 `newEntry`、`seedRefs` 等创建意图。A0 集成补充了三个界面的这个接口。
