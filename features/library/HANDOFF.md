# 材料藏书实现交接

实现与使用说明见 `docs/07-library-implementation.md`、`docs/08-library-notes-and-companion.md`。领域服务使用既有 Workspace；publication、annotation、importJob、libraryOperation 禁止通用提交入口直写。

2026-10-02 当前方向：用户明确要求取消应用内伴读，改为外部 Agent 驱动。`index.js` 不再挂载 chat-sidebar，左侧完整目录可收起；书架/阅读页顶部「Agent 接口」仅显示接入说明。`apps/server/main.js` 不实例化 Codex/Doubao/chat providers，旧聊天路径返回 410，既有聊天数据与密钥文件不删除。下文内置聊天实现均为历史，不能恢复为当前默认行为。

外部接口：`agent-guide.js` 为共享规范与 initialize instructions；新增 library_agent_guide，MCP/模型清单排除浏览器内部 reader_sync，仍为 46 项外部工具。`openapi.js` 生成 /api/library/openapi.json；/api/library/tools/{name} 提供对应 schema 的受保护 HTTP 调用。MCP 新增 guide resource 和 library-assist prompt；book_get_asset 返回受书籍归属验证的元数据，桥接器为不超过 8 MiB 的 PNG/JPEG/WebP 附上图片。`native-anchors.js` 让外部 API 创建的文字批注在 PDF 唯一对应的原文上显示；有歧义不猜位置。

阅读同步：命令含 pending/applied/failed，reader_sync 的 ackCommand 确认执行，commandError 表示失败；未确认命令不会被旧心跳覆盖。浏览器串行接收命令，实际执行后才 ACK；工具调用不续期浏览器心跳。`scripts/export-library-integration.mjs` 生成 integrations/chronicle-library 中的实际 Codex/MCP 配置、指南和 OpenAPI。尚未自动配置用户客户端；豆包普通网页/桌面未核实自定义 MCP 入口。最新验收见 quality/library-external-agent.json；151 项测试、85 模块检查。

2026-10-02 模型与 Agent 更新：`model-picker.js` 提供 Codex 动态模型/思考强度、多个豆包配置和 Agent/仅聊天切换。`reading-providers.js` 验证每轮模型能力并保存在服务数据目录中的方舟设置；设置接口不返回密钥。`doubao-provider.js` 实现官方 `/api/v3/chat/completions` SSE、图片和工具循环，限制官方 HTTPS 地址，处理取消/截断/鉴权。`agent-tools.js` 绑定当前书籍、版本、阅读窗口，复用 16 项原有图书工具，限制 16 次调用；稳定请求 ID 与领域修订检查保护批注写入，操作记录随聊天持久化。Codex 使用 app-server `model/list`、`thread/start.dynamicTools` 和 `item/tool/call`；只开放本机图书工具，关闭外部 MCP、shell、插件等。新增 `/api/library/chat/{models,settings,configure,test}`。146 项测试、80 个模块检查通过；真实 GPT-6.1-Sol 已完成精确下划线批注与翻页。豆包协议和界面测试通过，未获用户密钥，未测真实豆包推理。最新证据 `quality/library-model-agent.json`。

2026-10-02 直接聊天基础：`chat-sidebar.js` 替换旧的复制提问入口，固定输入区、流式 Markdown/数学回答、追问、停止、重试、多会话和刷新恢复。`chat-service.js` 用既有 discussion/message 持久保存；同一请求幂等、每对话并发锁、重试固定原页上下文。`codex-provider.js` 通过官方 app-server stdio 复用 Codex ChatGPT 登录，不读认证文件，不要求 API Key。临时线程、无执行环境，结束关闭子进程。网络重试使用最终 turn 内容替换未完成片段，停止可中断连接阶段。本机 HTTP 提供受令牌保护的 `/api/library/chat/{status,history,send,cancel}`，原 46 项外部工具不变。基础聊天证据见 `quality/library-codex-chat.json`，其旧的“仅回答、不调用工具”限制已由本次 Agent 更新替代。下文旧入口 `companion-sidebar.js` 已由 `chat-sidebar.js` 替代。

2026-10-02 滚轮与常驻栏更新：`wheel.js` 管理滚轮惯性、页内滚动边界及 Ctrl/Meta 缩放；`companion-sidebar.js` 为左侧常驻伴读入口，跟随页码和选区，回答仍在外部 Agent；`outline-ui.js` 为层级目录、当前项与无目录时的页码导航。`outline.py` / `outline.js` 读取原 PDF 书签，新转换保存，旧书有界缓存只读补取。真实 563 页书恢复 218 项目录，无需重新转换。全量 129 项测试和 69 个模块检查通过；UI 验证使用独立测试书库，Ctrl＋滚轮绑定由事件测试验证，物理组合未实测。证据：`quality/library-wheel-companion.json`。PDF.js 隐藏字体测量画布移出普通布局，修复拖选造成的外层滚动。

2026-10-02 沉浸阅读更新：`docs/09-immersive-library.md`。`room.js` 为轻量图书馆场景（真实书籍、WASD、关键词显示分组）；`immersive.css` 为独立布局、可收起目录/笔记、整页适应与翻页过渡；`reading-state.js` 管理连续翻页和阅读位置。先显示单页原图，独立加载 PDF 文字层，服务器新增 Range 流式分段读取及未变更文件的完整性验证复用。124 项测试、63 个模块检查通过；隔离 UI 验证移动、点击、连续翻页、刷新恢复、区域批注和文字精确引用。测试图非用户书籍。真实 563 页书仅做只读接口与 Range 验证。

2026-10-02 更新：原页区域标记支持直接选取、移动、八向缩放、键盘微调和自动保存，文字引用继续固定于原文；`region-edit.js` 为归一化几何与编辑手柄。`annotation_update.targets` 仅接受同页区域移动。新增 `reader_get_context`，共 46 项工具；阅读器有 AI 伴读设置与提示词。全量 119 项及 58 个模块语法检查通过，新增真实 MCP/HTTP 伴读集成测试。用户 Agent 的 MCP 配置未自动修改。

- `model.js`：规范文字、目标、格式验证、JSON-LD 交换、迁移候选。
- `service.js` / `schema.js`：46 项统一操作、版本检查、请求回执、串行转换任务与阅读器会话；独立转换结果在明确入库前没有 publication/source。
- `features/converter/`：转换、预览、下载及手动入库，按页预览且不启动阅读器。
- `metadata.js` / `metadata.py` / `metadata-ui.js`：PDF/EPUB 文件书目、封面与明确标签的本地识别；七个可编辑字段、字段来源和手动覆盖保护。新转换自动识别，旧转换通过 `conversion_detect_metadata` 补识别，不重新 OCR；`conversion_update_metadata` 保存校对值。2026-10-02 全量 111 项通过。
- `index.js` / `selection.js` / `style.css`：书架、阅读、DOM 与规范选区、标记绘制。2026-10-02 修复预览固定方框、误点生成不可见区域；两处保存按钮统一状态、会话草稿恢复、提交与列表读取分离。`selection.test.js` 覆盖十种几何和区域手势；全量 113 项通过。浏览器隔离测试覆盖保存失败、刷新草稿、重试与编辑，证据 `quality/library-annotation-fix.json`。
- `conversion.js` / `convert.py` / `windows-ocr.ps1`：隔离转换进程、PDFium、Windows OCR、EPUB，以及尚未实测的 Docling 适配器。
- `package.js`：阅读包目录边界校验；JSZip 只处理通过初步校验的包。
- `apps/server/uploads.js` / `apps/client/api.js`：512 MiB 上限、1 MiB 分段上传、进度与取消、30 秒请求超时及有限重试；Workspace 文件方式保存和校验大附件。`service.js` 流式导出阅读包，解压后上限 1 GiB。
- `scripts/library-mcp.mjs`：复用现有 MCP 桥接器的 library scope。

验证命令：`node --test features/library/*.test.js`、`node features/library/browser-check.mjs`、`node features/library/performance.mjs`。测试只使用隔离数据；浏览器测试生成自己的 PDF。性能报告明确区分领域服务耗时与浏览器/OCR。

上传回归：`node --test apps/server/uploads.test.js`。2026-10-02 全量 104 项通过，并在实际内置浏览器验证用户 132 MiB、563 页 PDF 上传、转换和下载，未自动入库；真实文件完整性证据在 `quality/library-large-upload.json`。第 2、26 页未提取到文字，仍保留原页。完整流程通过不代表公式和文字已校对。

待完成边界：Docling 及模型安装、真实藏书质量评估、完整 EPUB CSS/固定版式、复杂表格布局、跨页拖选、公式内部选取、扫描区域级混合识别与断点续算。原页可正确呈现不等于结构化公式已正确识别，不能隐藏两者的差别。
