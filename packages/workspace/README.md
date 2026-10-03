# A1 工作空间与数据

接口版本：contracts 1.0。Node.js 24 原生 ESM / `node:sqlite`；无安装依赖、无内存模拟。模块唯一持有本地 SQLite 与附件文件，调用方统一 `await` 即可。

## 接入

```js
import { Workspace } from './packages/workspace/index.js';
const workspace = new Workspace('/absolute/workspace');
const result = await workspace.commit({
  requestId: 'one-unique-request-id',
  changes: [{ id: 'entry-stable-id', objectType: 'entry', expectedRevision: 0,
    data: { body: '我今天了解到……', title: '', kind: 'note', status: 'adopted',
      occurrenceTime: null, placeRefs: [], citations: [] } }]
});
```

完整实现契约中的 `commit/get/list/history/searchSourceVersions/putAttachment/getAttachment/exportBackup/importBackup/stats/close`。

### 补充接口（已向 A0 报备）

- `list` 支持 `status`、`kind`、`placeIds`（任一匹配）、`unlocated` 和服务端纯函数 `predicate(object)`，在统计与分页**之前**过滤。A0 可使用 A3 的时间库构造 predicate；本模块不实现第二套时间算法。
- `list` 默认不含草稿。显式 `objectType:'draft'` 或 `includeDrafts:true` 可纳入。默认不含软删除；`onlyDeleted` 或 `includeDeleted` 可纳入。所有排序为 `updatedAt DESC, id ASC`，并返回准确总数和水位。
- `summary:true` 保留对象身份与业务字段，移除 `body/blocks/contextSnapshot`，补充派生 `title` 和 `bodyLength`。不是第二份权威对象，不用于直接回写。
- `listAttachments()` 返回真实附件清单，不读全部文件。
- `subscribe(listener)` 返回取消订阅函数；订阅只在本连接已提交后通知，不替代持久变更序列。监听错误不影响提交回执。
- `changesSince(sequence,{limit=10000})` 返回 `{items,sequence,nextSequence}`。limit 限制**完整提交批次**数，防止分页切断一次事务；调用方推进 `nextSequence`。跨进程变化可由该接口消费。
- `rebuildIndex()` 重建全文投影；`setIndexingPaused(boolean)` 为故障/恢复验收入口。恢复仅处理积压的变化对象；重建与恢复原子提交。
- `exportBackup(path,{onProgress})` / `importBackup(path,{onProgress})` 的进度含 `phase`、真实 `completedBytes/totalBytes`，版本校验阶段另含 `completedObjects`。未知总量为 null。进度回调异常不破坏任务。
- 可选构造参数 `{fault(point,details)}` 只用于故障测试，不是生产业务入口。注入点见单元测试。

## 存储与失败语义

- 数据库 `workspace.sqlite` 使用 WAL、FULL synchronous、事务内版本检查与持久幂等键。多连接并发写串行化；旧版本不会覆盖新数据。提交时索引通常同事务完成。
- 相同 requestId 和相同规范化内容返回原始提交回执；相同 requestId 内容不同时拒绝。同一事务不允许对同一 ID 写两次。
- 对象修订保留完整 JSON、创建/更新时间、软删除状态和附件引用。恢复仍使用原 ID 并产生新修订；固定引用通过 `get(id,{revision,includeDeleted:true})` 读取。
- 中文关键词为 Unicode NFKC / 小写的字面子串搜索；多个空白分隔词要求均出现。三个字符及以上使用 SQLite FTS5 trigram，短词使用字面子串投影。`%/_` 不会成为用户搜索通配符。没有语义搜索宣称。
- 资料检索只读取显式 `{sourceId,revision}`，不升级版本、不扩大集合；只有 `parseStatus:'ready'` 的文本参与。返回 locator 为原始 body 的 UTF-16 `[start,end)` 范围，text 与原文严格一致。缺少版本报 `REFERENCE_UNAVAILABLE`。
- 附件以随机内部身份命名，原始名称只保存在数据库。写入临时文件、fsync、原子改名后提交清单；读取与备份会重新计算实际文件 SHA-256。附件引用在保存时必须已存在。
- 正文写入中失败会回滚。提交后、回执前失败时错误带 `details.committed:true`，调用方保留内容并用原 requestId 重试即可拿到原回执，避免重复。
- v1 初始化在事务中完成；未来更高版本数据库或无法识别的旧库拒绝打开，不擅自迁移。之后新增 schema 版本时需要追加明确的可回滚迁移。

## 备份格式与恢复

`.chronicle` 是单文件原生容器，不是 ZIP：

1. ASCII 魔数 `CHRONICLE-BACKUP\n`。
2. 四字节大端无符号清单长度。
3. UTF-8 JSON 清单：格式/schema 版本、工作空间身份、对象与修订数量、所有完整修订的规范化 SHA-256、SQLite 快照文件长度/摘要、按附件 ID 排序的附件元数据/长度/摘要。
4. 指定长度的 SQLite 一致性快照。
5. 按清单顺序的附件原始字节。

SQLite 快照使用内置异步 backup；附件按 1 MiB 流式读写，不把 500 MiB 附件集合装入内存。对象摘要检查定时让出事件循环，附件复制有真实进度。导出期间继续编辑不会改变已经取得的快照；快照所用附件不删除或改写。最终导出拒绝覆盖已有备份文件，临时失败不会破坏较早备份。

恢复只接受没有对象、提交和附件的新工作空间。全部内容先在隔离目录展开并验证数据库、全部修订、当前版本、附件及其实际字节，再替换空数据库。持久恢复日志保护替换过程；进程在替换中退出时，下次打开会回滚到原空工作空间，允许重新导入。校验失败不改变当前数据库。原对象身份、每个修订、提交幂等回执、关系和消息引用全部保留。

## 验证

运行：`node --test packages/workspace/workspace.test.js`

目前 12/12 通过（Node 24.19.0，Windows）：

- C06：重试/重启幂等与不同内容碰撞。
- C07：六种对象跨 SQLite 连接的乐观冲突；多对象变更回滚。
- C08 服务部分：旧版本资料检索与准确片段，不扩范围。
- C09：暂停索引仍能读取真实正文，水位诚实，恢复收敛；重建失败保留旧索引。
- D01：含草稿、预言、消息、讨论、采纳、评估、软删除与修订的真实备份恢复；实际附件逐字节比较。
- D02：提交前、中、刷写前注入故障，以及提交后回执中断、空间不足错误映射。
- D03：截断、附件损坏、已有内容目标拒绝导入；失败后可重试完整备份。
- D04：初始化迁移失败回滚；未知高版本数据库保持内容不变。
- 恢复替换阶段的真实子进程退出：再次启动回滚、工作空间身份保持、完整备份可以重试导入。
- 中文检索、状态/地点/分页前 predicate、附件真实字节校验与文件路径约束。

没有模拟持久化。测试的 I/O 故障来自明确的测试注入，不宣称已进行物理断电或真实磁盘填满试验。

仍需 A6 独立验收：V1 全量数据与 500 MiB 附件的三次备份/恢复、100 次 P50/P95 查询与提交、100 次积压恢复耗时、真实用户流程与桌面交互。上述性能目标没有以小样本测试冒充通过。
