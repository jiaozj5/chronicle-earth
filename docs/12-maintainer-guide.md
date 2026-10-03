# 新窗口 Agent 接手与维护

本文件让后续开发不依赖上一段聊天的上下文。先读根目录 `AGENTS.md`，再读 [动机与愿景](10-origin-and-vision.md)、[当前状态](11-status-and-roadmap.md)。历史规格和交付报告提供背景；用户最新明确修正与实际代码决定当前行为。

## 获取代码与运行

```text
git clone https://github.com/jiaozj5/chronicle-earth.git
cd chronicle-earth
node --version
node apps/server/main.js
```

Node.js 必须为 24 或更新版本，包含内置 `node:sqlite`。打开 `http://127.0.0.1:4317/`。Windows 也可以双击 `start.cmd`；它在 PATH 找不到 Node 时尝试这台电脑的 Codex 附带运行时，因此新电脑应自行安装合适的 Node。

核心记录、地图、知识、阅读无需 npm 安装或构建，vendor 资源已随代码提供。初次启动创建新的 `.local/` 工作空间，只有导航地理数据，没有作者的史书或藏书。源代码仓库与个人内容备份是两套东西。

直接运行服务可用 `PORT` 改端口、`CHRONICLE_DATA_DIR` 改数据目录；`start.cmd`/`scripts/launch.mjs` 默认检查 4317 和项目 `.local/`，不应当作自定义端口的通用启动器。若为隔离试验启动服务，明确指定测试目录和独立端口。

转换 PDF/EPUB/图片的 Python 环境见 [转换环境](07-library-implementation.md)。Windows 可用：

```powershell
python -m venv .local/python
.local/python/Scripts/python.exe -m pip install -r features/library/requirements.txt
.local/python/Scripts/python.exe features/library/convert.py --check
$env:CHRONICLE_PYTHON = (Resolve-Path .local/python/Scripts/python.exe).Path
node apps/server/main.js
```

扫描识别依赖 Windows OCR 及相应语言包；其他系统不保证具备该能力。Docling 适配器存在但未验收。部分测试用 Python `reportlab` 生成合成 PDF，可在同一虚拟环境安装 `reportlab` 后执行，不把它混同为普通用户必需依赖。

## 代码地图

| 目录/入口 | 责任与修改注意 |
| --- | --- |
| `apps/client/main.js`、`routes.js`、`api.js` | 应用壳、路由、导航、会话/上传/跨模块通信；旧 `#convert` 归一到藏书子页 |
| `apps/server/main.js`、`validate.js` | 本机 HTTP 装配、Host/Origin 与令牌校验、领域写入、设置和备份 |
| `apps/server/operations.js` | 史书 9 项模型操作、日期/地点解析、幂等与修订约束 |
| `packages/contracts/` | 对象、关系、引用、错误和接口共同语义；先改契约再协调实现 |
| `packages/workspace/` | SQLite、修订、全文检索、附件、备份和恢复；不从业务模块绕过此层写数据库 |
| `packages/ui/` | DOM/Markdown/数学渲染与本地 vendor |
| `features/chronicle/` | 史书、草稿、预言、目录和修订 |
| `features/atlas/` | 时间、投影、中文地名、图层、绘制、探索；`data/` 为可发布导航资源 |
| `features/knowledge/` | 文稿、知识项、来源、引用、关系与反向引用 |
| `features/personas/` | 资料人物、模型适配、冻结讨论、引用与采纳 |
| `features/converter/` | 藏书内部转换界面；保留转换与入库两阶段 |
| `features/library/model.js`、`service.js`、`schema.js` | 阅读规范、不可变内容版本、批注、转换任务与工具合同 |
| `features/library/index.js`、`selection.js`、`region-edit.js` | 阅读 UI、规范选区、标记与批注保存 |
| `features/library/room.js`、`reading-state.js`、`wheel.js` | 书库场景、翻页、位置恢复、滚轮和缩放 |
| `features/library/convert.py`、`metadata.py`、`outline.py` | 原件转换、书目和 PDF 目录；`conversion.js` 管理隔离进程 |
| `features/library/agent-guide.js`、`openapi.js` | 外部 Agent 的权威指南与 OpenAPI 生成 |
| `scripts/agent-mcp.mjs`、`library-mcp.mjs` | 同一个本机 HTTP 服务的 STDIO MCP 桥，不另建数据副本 |
| `integrations/chronicle-library/` | 可分享的指南、接口描述、配置模板；实际路径配置在本机生成 |
| `tests/`、模块 `*.test.js`、`quality/` | 自动化、集成、性能与历史证据；报告的适用范围需单独读 |

## 核心数据约束

1. 对象 ID 稳定，修订递增。修改时使用实际读取的版本，不用覆盖写掩盖冲突。
2. 同一请求重试沿用 `requestId`；不同内容不能复用同一请求。收到回执或回读结果后才说明保存成功。
3. 引用区分 live 与 pinned；固定版本引用不能随源内容修改而暗变。资料、观点、模型输出和预言分别保留身份。
4. `publication`、`annotation`、`importJob`、`libraryOperation` 走藏书服务校验，不能通过通用 commit 绕过目标校验。
5. 原始文件、不可变 rendition 和独立 annotation 是三层。校对生成新 rendition，旧批注留在旧版；匹配不唯一时不猜位置。
6. 文字定位使用 Unicode code point 和精确引文，上下文核验后再写入；几何区域采用归一化坐标。不要拿 JS UTF-16 下标直接冒充协议位置。
7. 阅读命令 `pending` 只表示下发，需同一命令由浏览器 ACK 到 `applied`/`failed`。阅读会话临时存在，不等于内容保存。
8. 未收录、归属不完整或已删除记录不应错误点亮地图；区域关注不自动点亮内部城市。

## 开发和验证

首次接手先运行：

```text
git status --short
node scripts/check.mjs
node --test
```

2026-10-03 的基线是 90 模块检查、156 项测试通过。数字以后会变化，报告实际命令与结果即可。`scripts/check.mjs` 覆盖 apps/features/基础 packages 的 JS，不覆盖全部 scripts、Python 或第三方 vendor；新改入口应补充对应检查。

| 改动范围 | 推荐验证 |
| --- | --- |
| 数据层 | `node --test packages/workspace/workspace.test.js`，涉及备份/恢复时覆盖故障与往返 |
| 史书接口 | `node --test apps/server/operations.test.js`，必要时 `node tests/acceptance/map-agent-ui.mjs` |
| 藏书及外部接口 | `node --test features/library/*.test.js`，尤其 `external-agent.test.js`、定位/版本/重放测试 |
| 导航和中文地名 | `node --test apps/client/routes.test.js features/atlas/names.test.js` |
| 整体浏览器链 | `node scripts/acceptance.mjs`；需要 Playwright 和 Microsoft Edge，使用隔离工作空间 |
| 阅读器界面 | `node features/library/browser-check.mjs`，并核对脚本是否仍匹配当前界面 |
| 性能 | `node tests/performance/run.mjs` 或模块性能脚本；会生成较大测试数据，不作为每次小改必跑 |

使用 `tests/fixtures/harness.mjs` 的浏览器脚本优先寻找可解析的本地 `playwright` 包，再回退当前用户的 Codex 附带路径。新机器可单独安装开发依赖，例如 `npm install --no-save --package-lock=false playwright`，并准备 Microsoft Edge。Atlas/Knowledge 的早期独立浏览器脚本仍保留作者路径回退；运行这些脚本时用 `PLAYWRIGHT_PATH` 指向本机实际包目录，后续应统一依赖入口。当前未建立持续集成，某些旧 UI 断言可能随布局变更失效；失败时先区分产品回归与脚本过期，不删除断言来掩盖问题。

测试只写隔离数据。不能用真实书库批注、人物请求或已有记录作为“随手测试”。不得在日志或 Git 提交中输出密钥、会话令牌或用户正文。

## 接入外部 Agent

启动服务后运行：

```text
node scripts/export-library-integration.mjs
```

该脚本生成本机 `codex.toml`、`mcp.json`，并刷新指南/OpenAPI。前两者含机器路径，已被 Git 忽略；模板保存在 `.example` 文件中。脚本不修改客户端配置。复制配置、连接成功后遵循 [Agent 使用规范](../integrations/chronicle-library/AGENT_GUIDE.md)。应用内「Agent 接口」也可生成当前路径。

史书接口是 `scripts/agent-mcp.mjs`；藏书接口是 `scripts/library-mcp.mjs`。开发仓库的 Agent 与通过接口操作个人内容的 Agent 是两种任务，不应因为正在维护代码就去修改真实史书。

## 打不开时如何定位

- `node --version` 确认版本；`node scripts/launch.mjs --no-open` 观察启动结果。
- 查看 `.local/server.log` 与 `.local/server-error.log`，只摘录必要错误，不上传整份个人日志。
- 查询 `GET /api/session`，核对 `product` 为 `chronicle-earth`；首页返回 200 后仍需检查浏览器模块、控制台和当前数据请求。
- 端口被占用时先确认所属进程。不得批量终止所有 Node 进程；`scripts/restart-local.mjs` 是 Windows 开发辅助，只应在确认本应用、可重启时使用。
- 数据或数据库异常时先保护现有数据。不要删 `.local/`、重新初始化或新建空库来伪装修复；用隔离目录复现。
- 报告“服务恢复”和“根因修复”时分别说明证据。目前后台退出原因仍未确认。

## 每次交接留下什么

改动完成后更新当前状态和相关模块交接，记录：问题、最终行为、涉及文件、执行过的验证、未验证部分、下一步。历史报告保留日期，不把旧结果冒充新结果。若为下一位 Agent 留任务，写出一个可验证的完成条件，而不是只有“继续优化”。

可在新窗口直接使用这段提示：

> 请维护这个仓库。先读 AGENTS.md、README.md 和 docs/10-origin-and-vision.md、docs/11-status-and-roadmap.md、docs/12-maintainer-guide.md；检查当前 Git 状态和相关模块 HANDOFF。先区分当前实现、历史方案与尚未完成的目标，再处理我本次指定的任务。所有验证使用隔离数据，保留用户内容、引用版本和幂等语义，完成后更新交接文档并报告实际测试结果。
