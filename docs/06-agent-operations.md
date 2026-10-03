# 模型与 Agent 操作接口 · v1

应用提供结构化操作，模型可以把“在某一天、某个地点记录某件事”拆成查找地点、解析时间、保存记录。保存通过和界面相同的事务存储与校验；记录会出现在原有目录、地图和历史版本中。

接口只接受明确列出的字段。错误字段、错误日期、重复地点、过期版本和重复使用的请求标识都会返回结构化错误，失败时不写入部分内容。

## 接入

启动应用后，本机入口为 `http://127.0.0.1:4317`：

| 地址 | 用途 |
| --- | --- |
| `GET /api/operations/schema` | 操作列表、JSON Schema、function tool 描述 |
| `POST /api/operations` | 执行一个操作 |
| `GET /api/operations/connection` | 本机 MCP 客户端配置，含当前 Node 与脚本绝对路径 |
| `GET /api/session` | 获取当前会话 token |

支持本机 stdio MCP 的客户端可以使用 connection 返回的 `mcpServers` 配置，也可以在应用的工作空间设置中复制配置。入口脚本是 `scripts/agent-mcp.mjs`，支持协议版本 `2025-11-25` 和 `2025-06-18`。应用服务须先启动；配置中不包含模型密钥或会话 token，桥接脚本在连接时取得当前会话。

桥的能力范围为初始化、ping、tools/list 与 tools/call，采用逐行 JSON-RPC 标准输入输出；实现参考 [MCP 2025-11-25 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) 和 [工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。不声明未实现的协议能力。

远程模型不能直接访问你电脑的 `127.0.0.1`。实际调用由本机 MCP 客户端或你自己的工具执行器完成：将 schema 交给模型，接收模型的工具调用，用本机接口执行，再将结果返回给模型。模型服务仍由你选用的客户端配置；应用不会因为公开这些接口而自行启动模型请求。

HTTP 执行器先获取 `/api/session` 的 `token`，将其放在请求头 `X-Chronicle-Token`。服务重启后重新获取。接口仍只绑定本机，沿用应用的来源检查。

## 请求与回执

```json
{
  "version": "1",
  "operation": "create_entry",
  "requestId": "一个新生成并在重试时保留的标识",
  "arguments": {
    "title": "我记录的事件",
    "body": "完整记录正文",
    "kind": "note",
    "status": "adopted",
    "time": "2026年10月2日",
    "placeIds": ["从 search_places 返回值中选择的确切 ID"]
  }
}
```

只读操作不传 `requestId`。所有写操作必须传 `requestId`，1–180 个字符；调用端可以生成 UUID。网络中断后，使用同一个标识和相同参数重试。回执已保存时会返回第一次提交的结果；不会重复新增记录，也不会覆盖随后发生的编辑。即使重启应用、地点已改名或删除，原回执仍可恢复。改变指令内容必须换一个标识，否则返回 `IDEMPOTENCY_CONFLICT`。

```json
{
  "version": "1",
  "operation": "create_entry",
  "replayed": false,
  "result": {
    "commitId": "…",
    "sequence": 10,
    "objects": [{"id": "…", "objectType": "entry", "revision": 1, "data": {}}]
  }
}
```

`data.agentOperation` 保留操作版本、请求标识、操作名和参数指纹，用于审计和恢复原始回执。此字段由服务生成，模型不能自行传入。模型对已有记录的编辑会保留其他元数据、已有引用与首次预言版本。

schema 同时提供 function tool 格式：工具参数内含写操作的 `requestId`。执行器应将它移动到 HTTP 请求的顶层，其余字段放到 `arguments`。MCP 桥已经处理这一转换。

## 功能范围

| 操作 | 参数要点 | 结果与限制 |
| --- | --- | --- |
| `search_places` | `query`；可选 `country`、`includeDeleted`、`limit`、`offset` | 名称和别名搜索，含国家、地区、坐标、版本、是否自定义 |
| `parse_time` | `time` | 时间对象、显示文本、是否可索引、是否需要澄清 |
| `list_entries` | 可选 `query`、`placeIds`、`kind`、`status`、`includeDeleted`、`limit`、`offset` | 记录摘要，默认20条、最多100条，返回 `nextOffset` |
| `get_object` | `id`；可选 `revision`、`includeDeleted`、`bodyOffset`、`bodyLimit` | 只读记录和地点；正文默认16000字符、最多64000字符，支持分段读取 |
| `create_entry` | 必填 `body`、`kind`、`status`、`time`、`placeIds`；可选 `title`、`conditions` | 新增记录或预言；不会自行补全缺失事实 |
| `update_entry` | `id`、`expectedRevision`、`patch` | 修改列出的记录字段；未列出的字段不变 |
| `create_place` | `name`、`kind`、`coordinates`；可选 `aliases`、`country`、`region`、`geometry` | 创建自定义地点；坐标为 `[经度,纬度]`，未知用 `null` |
| `delete_place` | `id`、`expectedRevision` | 自定义地点可恢复删除，保留所有记录与引用；内置地名不接受删除 |
| `restore_place` | `id`、`expectedRevision` | 恢复自定义地点，版本应使用删除后的当前版本 |

目前没有开放任意对象写入、设置修改、密钥读取、删除记录、执行代码或批量清空。这些操作不会被模型通过此接口隐式执行。

### 地点如何消除歧义

`search_places` 返回 `resolution`：

- `unique_exact`：有且只有一个名称或别名完全匹配，`resolvedPlaceId` 为该地点。
- `ambiguous_exact`：有多个完全匹配，`resolvedPlaceId` 为 `null`；结合国家、地区、坐标和用户说明确认候选。
- `candidates`：仅有包含关键词的候选，`resolvedPlaceId` 为 `null`。
- `none`：没有候选。

`exactMatchCount` 的统计发生在分页之前，页面只显示一个结果不会被误判为唯一。`exactMatches` 最多返回100个；完整候选可翻页查询。不要把“第一个候选”当作用户已经确认的地点。创建记录只接收确切 `placeIds`，不接收模糊地名。没有合适地点时，可按用户给出的信息创建自定义地点；不得猜测经纬度。

### 时间和收录状态

`time` 接受明确日期、年份、范围（如 `公元前221年`、`2026年10月2日`、`1850至1860年`），或与应用相同的完整 TimeSpec，也可以为 `null`。公元纪年没有0年。无法解析的原话会保留，绝不补成今天或某个推测日期。

`kind` 必须明确指定：`note` 是普通记录，`prediction` 是预言。模型应按用户的意思决定，不能把未来的推测写成已发生的事实；接口不会仅靠日期替用户改变记录性质。已存在的预言不能被更新为普通记录，首次预言版本会一直保留。

`status:'adopted'` 需要可索引的时间以及至少一个已确认地点。信息不完整时可以询问用户，也可以在用户允许时以 `status:'inbox'` 保存原文。`inbox` 不点亮地图。确认了名称但没有坐标的地点可以被记录引用，地图会将其归为无法定位内容，直到补充坐标或范围。

上述归属要求用于创建记录，以及明确修改 `status`、`time` 或 `placeIds` 的操作。对已有记录只修改标题、正文、类型或预言条件时，保留其原有归属；即使它是在界面中创建、尚未补全时间地点的已收录记录，也允许继续修改文字。显式清空已收录记录的时间地点仍会被拒绝；如需移到待补充状态，请明确改为 `inbox`。

更新使用 `expectedRevision` 防止覆盖其他编辑。收到 `VERSION_CONFLICT` 后先重新读取，比较用户要求与最新内容，再生成新请求；不要盲目把版本数字加一重试。

## 一个可以运行的本机调用示例

将以下内容保存为一个 `.mjs` 文件，用 Node 运行。示例先查找和解析，同名地点不会自动写入。后面的 `create_entry` 会实际新增记录，因此执行前应将正文改成要保存的内容。

```js
const base = 'http://127.0.0.1:4317';
const {token} = await (await fetch(`${base}/api/session`)).json();
async function call(operation, args, requestId) {
  const response = await fetch(`${base}/api/operations`, {
    method: 'POST',
    headers: {'Content-Type':'application/json', 'X-Chronicle-Token':token},
    body: JSON.stringify({version:'1', operation, arguments:args,
      ...(requestId ? {requestId} : {})})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
}
const places = await call('search_places', {query:'北京'});
if (places.resolution !== 'unique_exact') {
  console.log(places);
  throw new Error('请先根据候选确定地点，再执行保存。');
}
const when = await call('parse_time', {time:'2026年10月2日'});
if (!when.indexed) throw new Error('请先确定时间。');
const requestId = crypto.randomUUID(); // 保存此值，网络重试仍用原值
const saved = await call('create_entry', {
  title:'我的记录', body:'这里填写我确认要保存的正文。',
  kind:'note', status:'adopted', time:when.time,
  placeIds:[places.resolvedPlaceId]
}, requestId);
console.log(saved.objects[0].id, saved.objects[0].revision);
```

## 验证

`node --test apps/server/operations.test.js` 检查真实 SQLite 的解析、歧义、参数拒绝、持久化幂等、进程重开、版本冲突、地点删除与恢复、收件箱不点亮地图，以及分页读取。所有测试使用隔离目录，不接触实际用户工作空间。

这些验证覆盖操作和数据行为。实际模型是否正确理解任意自然语言指令仍取决于接入的模型和客户端，需要接入后另行评估；应用不将本地模拟调用当成真实模型效果。
