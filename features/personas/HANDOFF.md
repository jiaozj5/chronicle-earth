# A5 人物与交流交接

接口版本：contracts 1.0。全部实现位于 `features/personas/`，没有写入其他模块、没有新增包依赖、没有访问 Codex 凭据。2026-10-01。

## 已实现

- `index.js` 导出 `mount(container, ctx)`，返回 dispose / refresh / open。使用共同 DOM/Markdown UI 与全局主题；人物编辑草稿和未发问题在当前浏览器 sessionStorage 保留，正式数据只有 A1 Workspace 一处。
- 人物名称、介绍、图片附件、风格、用户诠释、笔记、多份 Source 选择；材料明确显示 ready / unparsed / unavailable 和版本、文本量。不宣称资料完整。
- 可从记录/知识项/文稿选中上下文进入。准备讨论时固定 personaRef、sourceRefs、contextRefs，发起前可查看范围和版本。无模型配置仍可以编辑人物和准备讨论。
- 真正的 `chat/completions` HTTP 适配。root、`/v1`、完整路径均可配置；密钥仅服务器读取 settings，前端不保存/回显。没有假回复回退。
- 限定资料版本检索（问题无匹配时只在同一集合搜索空串）；最大 24,000 字材料、18,000 字选定上下文、24,000 字最近讨论，截断和较早消息省略明确保留。无关工作区内容不作为模型上下文。
- 稳定问题/回答对象；持久化中断状态、取消、60 秒超时、认证/限流/网络/格式错误、重试；重试产生新回答身份并指回原问题。`turnOrder` 保证顺序。
- 同一 requestId 完全相同载荷重放；不同 start/send 意图拒绝，save 通过 A1 幂等保证。新人物 ID 基于 requestId 稳定。
- 模型协议要求 JSON segments，逐段区分材料解读、讨论推演、原文。只有通过 A4 `validateCitation` 的固定版本引文显示为原文；越界、伪造和版本不符的引用隐藏并提示，禁止将不合规原文冒充核验成功。
- 主动、可编辑采纳至新建或已有 Entry / Knowledge / Document；通过 A0 `api.adopt` 原子提交，已有目标携带 targetRevision；不直接修改领域内容。成功回执可打开目标或调用保护性撤销。

## HTTP 路径

由 A0 将 `/api/personas/:path` POST 转发到 `handleRequest(path, body, {workspace, settings, signal})`。

| path | body | result |
|---|---|---|
| save | `{data,id?,revision?,requestId?,newId?}` | `{persona,...commit}` |
| coverage | `{sourceIds}` | `{coverage}` |
| start | `{personaId,contextRefs?,title?,requestId}` | `{discussion}` |
| send | `{discussionId,body,requestId,retryOf?}` | `{message,error?,replayed?}` |
| cancel | `{discussionId}` | `{cancelled}` |
| status | `{}` | `{configured,runningDiscussions}` |

send 的服务错误若已保存问题，会返回带 failed/interrupted 状态的消息以及 error；配置缺失等提交前错误抛 DomainError。pending 回复以 interrupted 状态持久化并带 `pending:true`，进程意外退出后可识别为未完成并重试，不会伪装已完成回答。

服务提供 `fetchImpl` 和 `timeoutMs` 仅为确定性协议测试入口；生产通过系统 fetch，UI 不暴露此替换能力。

## 验证

`node --test features/personas/service.test.js`：10 / 10 通过。

- A01：编辑人物风格/诠释不更改原始来源；save/start 重放和冲突。
- A02：ready / unparsed / unavailable 资料覆盖准确。
- A03：真实 SQLite 来源更新后仍检索版本 1，唯一校验器核验文字和定位；伪造及越界引文不显示为原文。
- A04：人物其他资料和私人无关记录不进入发送内容；人物配置也被冻结。
- A05：无配置不生成消息；限流、网络、超时、取消、错误格式持久状态；原问题重试不复制问题；可继续下一问。
- C06：消息相同请求重放不再调用 provider，不同内容拒绝。
- 本地 HTTP 服务器验证实际 URL、鉴权头、payload 和响应协议。明确是合成 provider，绝不作为 A07 真实服务证据。

另运行 `node --check features/personas/index.js` 和 service.js。跨模块采纳/撤销、真实浏览器交互和桌面视口由 A0/A6 验证。

## 未验证项与限制

- 用户明确要求稍后在设置连接模型；A07 真实服务 2 人物 × 10 任务尚未运行。真实服务质量、供应商兼容性和外部响应分布不宣称通过。
- 适配仅覆盖兼容 Chat Completions 的文本非流式接口，模型必须遵守提供的 JSON segments 协议；不支持仅 Responses、工具调用或只能流式响应的服务。
- 不解析未解析附件，不自动网页抓取，不扩大材料范围，不代用户自动采纳。
- 人物/讨论标题和问句草稿为本浏览器会话草稿；正式对象和消息进入 Workspace 备份。编辑界面显示相应提示。
- 运行中的单场讨论使用服务内锁；重新启动后未完成回复保留，可由用户重试。不会后台自动继续向外部服务发送。

无 schema 迁移。扩展字段均置于 data 内（source coverage、请求指纹、turnOrder、片段、消息上下文快照、错误状态）。
