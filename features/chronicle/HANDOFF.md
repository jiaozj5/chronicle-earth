# A2 记录与阅读交接

2026-10-01，接口契约 1.0。仅修改 `features/chronicle/`。模块可集成；完整 G1/G4 仍由 A0/A6 验收。

## 交付

- `index.js`：真实 API 驱动的目录、正文、编辑器、草稿恢复、检索和分页；全部/待定位/待整理/草稿/回收站；多地点、原始地名、时间原文、来源引用；预言与固定版本复盘；历史版本人可读比较和建立新修订。
- `service.js`：Entry、PredictionReview、采纳与撤销的业务准备；DraftSession 串行自动保存、上下文快照、并发写入保护、网络未知结果幂等重试、失败保留、正式记录与草稿删除原子提交。
- `style.css`：局部安全布局、独立实底正文、窄容器自适应、可见键盘焦点、暗色适配。目录密度与记录正文分离。
- `service.test.js`：13 项显式 API 夹具测试，验证业务操作顺序与失败保留，不冒充真实磁盘验收。
- `workspace.integration.test.js`：2 项真实 SQLite 集成测试，包含关闭后重开、草稿收录事务、中文检索、待定位、并发冲突、预言修订和固定版本评估。

## 公共接口

`await mount(container, ctx)` 返回：

- `newEntry(selection?)`：使用当前或传入时空上下文建立草稿；已有草稿先持久化。
- `open(id, revision?)`：正式记录、草稿或评估关联预言。
- `search(text)`：全文词搜索，保留可见时空筛选。
- `setContext(selection)`：更新目录筛选与下一笔上下文，不改当前草稿。
- `refresh()`：刷新地点列表与记录目录，不重建编辑器。
- `dispose()`：保存草稿和选区，再释放监听器；保存失败抛错，调用者不得切走未保存编辑器。

依赖 `ctx.api.list/get/history/commit/remove/restore` 与 `ctx.onLocate/onDevelop/onDiscuss/openObject/notify/refresh`。共享 UI 的 `renderMarkdown` 返回安全 Node。时间只通过 A3 `parseTime/formatTime/toRange`。

业务服务：

- `blankEntry(selection?)`
- `validateEntry(data)`
- `prepareEntryChange(data, existing?, newId?)`
- `prepareReviewChange(data, existing?, newId?)`
- `prepareAdoptionChange({target?, objectType='entry', data, messageRef, newId?})`
- `prepareUndoChange(current, before, expectedRevision)`

以上准备函数仅返回变化；A0 组合采纳回执后原子提交。冲突码统一 `VERSION_CONFLICT`。

## 已执行检查

`node --check features/chronicle/index.js`

`node --test features/chronicle/service.test.js features/chronicle/workspace.integration.test.js`

结果：15/15 通过。350 ms 去抖夹具检查的持久化回执约 350–365 ms，此值不代替真实浏览器 P02 或整个基准性能报告。Node 的真实 SQLite 集成约 50–70 ms / 用例（同样不作性能门禁结论）。

覆盖的局部语义：R01/R02/R05/R08/R09、C06/C07、R10 的采纳准备。真实端到端、输入法、键盘、屏幕尺寸、地图串联与批量性能由 A6 继续验收。A0 已反馈真实浏览器基本保存和刷新通过，无 JS 错误；其发现的紧凑目录分页溢出已修复，需在最新样式复核。

## 保存与错误状态

草稿在暂停输入 350 ms 后保存；输入期间不会重建 textarea。API 成功回执之后才显示已保存。正在保存时继续输入，旧快照完成后立即保存新快照；重复请求保持完全相同的 requestId 和载荷。

正式提交结果不确定时暂停对该快照的修改，保留原文和同一笔重试。收到明确版本冲突时仍保留草稿，允许另存为新记录；草稿本身在其他窗口被更新时可保留为独立草稿。版本恢复不会删除历史。预言身份和首次预言版本不随时间变化。

评估使用显式保存；离开未保存评估有提示。评估提交也保留相同请求供未知结果重试。

## 未宣称完成的部分

- 未执行真实目标用户测试及一周复访。
- 未独立执行 10,000 条记录、100 次 P95 的浏览器性能验收。
- 未独立完成完整 R03 中文输入法和 200% 缩放人工任务；代码已处理 composition 与组合输入提交保护。
- 来源创建、人物生成和地图计算由所属模块提供，A2 不另建权威库、不预填演示史实。

无迁移影响。全部正式内容通过 A1 存储；仅视图位置暂存于模块内存，不使用第二套内容数据库。
