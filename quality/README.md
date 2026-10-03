# 验证证据索引

报告只证明它记录的日期、版本、环境和场景。文件名含 `latest` 也不保证与当前源码同步；不同阶段的测试数不能相加成当前覆盖。

## 2026-10-03 源码交接基线

- [handoff-validation.json](handoff-validation.json)：本次实际执行的摘要。
- [handoff-tests.txt](handoff-tests.txt)：本次 156 项测试输出，0 失败、0 跳过。
- `node scripts/check.mjs`：90 个模块检查通过。

本次未重跑全套 UI、性能、OCR 或真实模型质量评估；未向真实用户工作空间加入测试内容。

## 仍有参考价值的阶段证据

| 报告 | 内容与边界 |
| --- | --- |
| [library-navigation-map-names.json](library-navigation-map-names.json) | 转换并入藏书、旧链接兼容、2,524 个内置地点中文标签；此前隔离 UI 与 156 项测试 |
| [library-external-agent.json](library-external-agent.json) | 当前外部 Agent 方向：46 工具、独立 MCP 进程、批注回读、浏览器翻页 ACK、无应用内聊天 |
| [library-browser.json](library-browser.json)、[library-annotation-fix.json](library-annotation-fix.json)、[library-natural-notes.json](library-natural-notes.json) | 阅读、选区、批注、保存故障/恢复等阶段检查 |
| [library-immersive.json](library-immersive.json)、[library-wheel-companion.json](library-wheel-companion.json) | 书库、沉浸阅读、目录、翻页缩放；旧伴读 UI 部分已被后续方向替换 |
| [library-large-upload.json](library-large-upload.json) | 大文件传输、原件哈希、包资源完整性；不证明 OCR 或公式精度；不附原书 |
| [library-performance.json](library-performance.json) | 合成书库的领域服务性能；不包含浏览器/OCR |
| [map-agent-ui.json](map-agent-ui.json) | 地图主体、自定义地点和史书操作接口 |
| [验收结果.md](验收结果.md)及 acceptance/cloud/full-chain/shell 报告 | 首版功能矩阵及集成；真实模型与真人任务的未验项明确保留 |
| performance 系列 JSON | 历史合成数据规模、备份恢复和界面性能；不能冒充普通低配机器结果 |
| [unit-tests.tap](unit-tests.tap) | 首版 78 项单测历史，当前数量看 handoff 文件 |

## 已停用功能的历史证据

`library-codex-chat.json`、`library-model-agent.json` 记录旧阅读器内聊天与模型调用，保留用于理解演进和兼容。当前阅读器不挂载这些功能；其中真实 Codex 推理成功不等于当前外部客户端已配置，更不代表「云上人物」的真实质量门禁通过。

截图和临时测试目录保留在本地，未加入公开源码仓库。因此历史报告中的截图路径可能无法在 GitHub 打开；这不表示本次重新生成了截图。`features/atlas/quality/`、`features/knowledge/qa/` 里的 JSON 同样是模块历史记录。

首次公开交接将历史 JSON 报告中作者电脑的绝对项目路径改成仓库相对路径；测量数据与结果未改变。

再次验证时记录具体命令、环境、数据是否合成、是否使用真实供应商和未覆盖范围。不要覆盖旧报告后仍把旧日期/数字当成新证据。
