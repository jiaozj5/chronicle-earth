# 材料藏书实现与使用

当前导航：进入「材料藏书」内的「格式转换」，主导航不再单列转换；旧 `#convert` 链接仍兼容。阅读器内聊天已取消，使用外部 Agent，见 [接入说明](../integrations/chronicle-library/README.md)。本文后半部分保存各阶段验证历史，当前汇总见 [实现与后续工作](11-status-and-roadmap.md)。

2026 年 10 月 2 日，项目已接通可使用的书架、阅读器、批注、文件转换及 Agent 操作接口。实现采用原件、不可变内容版本、独立批注三层存储，沿用工作空间的 SQLite、附件、修订和备份。以下说明已交付行为及验证边界；完整目标仍见原方案。

## 阅读和批注

流程已拆成两个独立步骤。先从材料藏书内的「格式转换」上传 PDF、EPUB、TXT、Markdown、常见扫描图片，或粘贴正文。转换完成后逐页预览原页和识别内容，可以直接下载 `.book.zip` 文件。此时只保存转换任务和附件，不创建藏书或来源正文，也不打开阅读器。单个上传文件最多 512 MiB，按 1 MiB 分段发送，显示百分比与已传大小，可取消。每次请求 30 秒超时，暂时断连最多自动重试两次；重复分段和完成请求不会重复写入。转换启动后显示总页数，刷新页面可回到当前结果。

检查结果后，点击「加入藏书」并填写书名和书架，才建立藏书；已有转换内容及附件直接复用，不重复 OCR。也可以稍后在「材料藏书」点击「加入阅读包」导入下载的 `.book.zip`。转换任务支持刷新恢复、取消和重试；未入库的结果可以一直单独保留。

为减少转换与阅读互相影响，后台转换串行执行，进度最多每 500 ms 或最后一页写入一次。转换页只加载当前预览页，仅在存在活动任务时轮询，不加载 PDF.js 或阅读器同步会话。已完成书籍停止查询转换状态，外部批注更新只重画标记，不重建 PDF 画布。

PDF 与扫描图片默认呈现原版。重排阅读便于选择与改字号，并排视图供人工校对。文字选择会转换为规范文字的 Unicode code point 范围，核对精确引文和上下文。行内与独立公式作为整体选择，避免 KaTeX 的显示层和无障碍层造成重复文本。暂不支持公式内部符号级选择。

支持高亮、下划线、方框、三角形、实心点、空心圈、大圆圈、叉号、对号和斜杠。可改颜色、写批注、修改、删除、恢复、撤销和重做。框选原页适用于图片、公式或无法可靠匹配文字的位置。扫描 OCR 使用词框定位，不能将词框误称为逐字精确几何。

校对会生成新的内容版本。旧批注仍固定在原版本；书目菜单中的「全部版本批注与回收站」可定位历史原文、恢复批注、预览迁移。只有唯一对应的文字才能在迁移对话框中确认应用；其他情况应重新选择目标。已独立编辑的原材料不会被后台转换或书内校对覆盖。

保存采用持久请求回执、版本检查和软删除。浏览器保存未收到回执时保留请求标识，重复提交同一内容不会重复新增。批注草稿保存在当前浏览器会话。目录、正文和批注按页读取，整本书不会一次加入 DOM。

## 当前转换能力

| 输入 | 已实现 | 边界 |
|---|---|---|
| TXT 与 Markdown | 正文、标题、代码、强调、行内和独立 LaTeX 公式 | Markdown 远程图片保留标签，不自动下载；复杂表格布局不等同原版 |
| EPUB | 按 spine 顺序读取 XHTML、强调、图片、MathML，保留原 EPUB | 统一重排样式；尚未实现完整 EPUB CSS、交互、多媒体、固定版式、DRM 或 Readium 兼容性 |
| 原生 PDF | PDF.js 原版及文字层；PDFium 提取规范文字和页面图 | 复杂版面的阅读顺序、连字、脚注和公式语义可能有误；未经校对 |
| 扫描 PDF 与图片 | 本机 Windows OCR；词框和文字关联；保留页面图 | 取决于系统语言包与扫描质量；基础 OCR 不识别可靠 LaTeX，不保证横竖排、双栏或歪斜扫描正确 |
| Docling 增强 | 已编写隔离转换适配器，可发布新的内容版本 | 本机未安装，包下载连接重置；尚未验证模型、公式识别或真实书籍结果，不能视为已经可用 |

自动模式按页提取文字，短文本页尝试扫描识别。原生文字与扫描图片混在同一页时，尚未做完整的区域级混合识别。原页图片和 PDF 保留原有公式外观；识别副本不替代原始证据。转换中断或失败显示具体状态，保留原件，可取消、重试或切换引擎；当前不支持从中断页续算。

当前机器已核实 Python、PDFium 5.13.0、Pillow 12.3.0 和 Windows OCR 中文语言包可用。前端资源已随项目提供，普通阅读无需 npm 安装。其他机器可安装 `features/library/requirements.txt`，并把 `CHRONICLE_PYTHON` 指向该 Python 后启动服务。路径也自动检测项目 `.local/python/Scripts/python.exe` 和本机 Codex 提供的 Python。EPUB 解析使用 Python 标准库。

可在独立虚拟环境中执行以下命令；需要能访问包源。增强转换另需安装 Docling，并按其官方说明准备模型，不能用“模块存在”替代转换测试。

```powershell
python -m venv .local/python
.local/python/Scripts/python.exe -m pip install -r features/library/requirements.txt
.local/python/Scripts/python.exe features/library/convert.py --check
```

## 运行格式

当前规范名称为 `chronicle-reading-1`。早期草案 v0.1 的展示字段不作为导入契约；以 `features/library/model.js` 的验证、`schema.js` 的接口及同目录示例为准。

| 对象 | 关键字段与规则 |
|---|---|
| publication | `sourceId`、原件附件及 SHA-256、`currentRendition`、内容版本列表、所有依赖附件；删除不移除历史 |
| rendition | JSON 附件，含 `profile`、`renditionId`、`engine`、`pages`、`blocks`；已发布版本不覆盖 |
| block | 稳定 `id`、`kind`、`pageIndex`、NFC/LF `text`、`runs`、识别状态与可用的来源区域 |
| run | 普通 `text`，或 `atom: formula/image`；公式为 LaTeX 或 MathML，图片指向附件；原子在规范文字中占一个 U+FFFC |
| text target | `blockId`、半开区间 `[start,end)`、精确 `exact`、最多 24 字符 `prefix/suffix`；不拆开组合字符 |
| object target | 指向完整公式或图片块；混排中的原子使用长度为 1 的文字目标 |
| region target | 从 0 开始的 `pageIndex`，左上原点归一化 `[x,y,width,height]`；与缩放无关 |
| annotation | 固定 `publicationId/renditionId`、一个或多个目标、标记类型与颜色、批注正文、作者；独立修订 |

跨段选区存成多个目标。跨页可由接口提交多个目标；当前界面逐页阅读，不支持拖动跨页选择。原生 PDF 的文字选择仅在当前页能够唯一精确匹配规范文字时接纳；重复引文或不一致情况提示改用重排文字或区域选择，不猜测绑定。

`.book.zip` 包含 `manifest.json` 和 `assets/`。manifest 收录书目、所有内容版本、资源清单及 JSON-LD 批注；资源带 SHA-256、尺寸和 MIME。导入校验路径、重复名字、资源哈希、资源归属和目标内容，创建新藏书身份并重映射引用。限制为 1 GiB 解压后大小、512 MiB 导出包大小、不超过 20,000 个文件；不支持加密、分卷和 ZIP64。打包、附件保存及下载采用文件流，避免将整本书和全部页图同时放进内存；阅读包导入仍使用 JSZip，受上述大小限制。超限使用工作空间完整备份。单独的批注 JSON-LD 需要相应内容版本已经存在；跨工作空间迁移请用阅读包。

批注导出使用 W3C Web Annotation 的 `TextPositionSelector`、`TextQuoteSelector` 或 `SvgSelector`，并以 `cr:` 扩展保存内容版本、全部标记和目标数组。标准工具可以读取引文、批注和选择器，自定义符号仍需要本规范支持。未知顶层字段保存于 exchange 副本；权威字段以重新验证的本机数据为准。

## Agent 接入

转换完成时自动识别书名、作者、副标题、出版社、出版日期、ISBN 和语言：优先 PDF Title/Author 或 EPUB Dublin Core，再从前六页已识别文字中的明确书目标签和封面提取。中文著者标签、带机构信息的英文多作者封面可识别；未知版式不保证识别。无书名时退回文件名，其他未知项留空。PDF Creator/Producer 与 CreationDate 不作为作者、出版日期；ISBN 自动识别校验校验位。

转换结果的「书目信息」卡片标明来源和待核对状态，可保存修改或「重新识别书目」。旧转换结果可点击「自动识别书目」，复用已转换文字，仅额外读取文件属性，无需重新 OCR。手动字段（含明确清空的作者等字段）不被再次识别覆盖。字段随下载、加入藏书及阅读包迁移保存，阅读器「书目与导出」也可编辑。修改转换任务不会改写已经加入藏书的独立书目；已下载包需重新下载才包含新书目。

`conversion_detect_metadata`、`conversion_update_metadata` 均需要 `id/expectedRevision/requestId`。返回书目与识别来源；对象的 `metadataDetection.fields` 提供来源、置信等级和封面页码/块引用，`metadataOverrides` 记录手动字段。这两项操作不会创建藏书或重新生成内容快照。`conversion_start/add`、`library_import/update_metadata` 支持七个书目字段。

书架上的「Agent 接口」提供绝对路径 MCP 配置。服务运行时，从支持本机 stdio MCP 的客户端启动 `node scripts/library-mcp.mjs`，或使用应用生成的完整配置。此接口复用项目已有 MCP 桥接器；SDK 包未成功下载，尚未替换为官方 SDK，已验证协议初始化、工具发现和真实调用。

`GET /api/library/schema` 返回 46 项操作及封闭 JSON Schema；`GET /api/library/connection` 返回配置；`POST /api/library` 接受 `{operation, arguments}`。写请求需要本机会话令牌，持久写入必须有 `requestId`，修改现有对象还需 `expectedRevision`。二进制文件先分段上传，再将 `attachmentId` 交给 `conversion_start`。使用 `conversion_list/preview/export` 检查或下载，用户决定加入后调用 `conversion_add`。`library_import` 保留兼容入口，并用于导入已有阅读包；MCP 不读取任意本机文件路径。

上传协议：`POST /api/uploads` 提交 `{id: UUID, name, mime, size}`，返回 `offset/chunkBytes`；按返回分段大小依次 `PUT /api/uploads/:id?offset=N` 发送二进制；`POST /api/uploads/:id/complete` 校验完整长度、落盘并返回附件元数据；`DELETE /api/uploads/:id` 释放传输状态和临时分段，不删除已完成附件。中断任务 30 分钟后清理，服务重启后须重新上传；完成文件始终保留。旧 `/api/attachments` 单次上传入口仅兼容 64 MiB 以下文件。

典型调用顺序：`library_capabilities` → `library_list` → `book_outline/book_read` → `selection_resolve` → `annotation_create` → `annotation_read_context`。最后一个接口一次返回批注、固定原文、公式表示、图片引用、出处和识别状态。资源 URL 由 `book_get_asset` 获取。HTTP 与 MCP 共用领域服务，通用对象写入接口不能绕开批注校验。

`reader_get_state` 列出在线阅读器，`reader_open/navigate/set_selection/set_view/set_preferences` 定位指定会话。浏览器约每 3 秒同步，60 秒无心跳的会话过期。会话定位是临时状态；书籍和批注保存在 SQLite。

## 验证记录

`node --test` 的 113 项检查通过，包含真实 SQLite、HTTP 与 MCP 检查。材料藏书专项覆盖 Unicode 和组合字符、全部十种标记、选区与引文不一致、版本冲突、持久请求重放、撤销重做、校对后历史引用、阅读包往返、资源路径重复拒绝、原材料编辑保护，以及 EPUB 图片和 MathML 解析。新增独立转换不创建藏书、导出与服务重启后预览、取消和重试、入库复用同一份内容及重复入库保护。上传回归覆盖 65 MiB 文件、分段和完成回执丢失、取消、超限和冲突拒绝、磁盘提交失败后重试；另验证 257 MiB 资源的阅读包导出及往返。

2026-10-02 修复批注预览固定显示方框的问题：选区即时采用所选符号和颜色，编辑时隐藏旧图形以避免重叠。原页区域采用指针捕获；实心点、空心圈、对号、叉号、斜杠可单击，其他符号需拖动，避免保存一像素的不可见区域。两处保存按钮统一禁用和状态提示，提交成功后局部更新；读取列表失败不再误报写入失败。草稿在当前浏览器会话保存文字、位置、符号、页面、视图及编辑修订号，刷新后可恢复；保存期间产生的新改动不会被旧回执清空。草稿不是已入库批注，关闭浏览器会话不保证仍存在。

新增 `selection.test.js` 验证十种几何图形、单击与拖动区分、点标记尺寸和边界。实际内置浏览器在独立工作空间验证三角形、大圆圈、实心点、已有批注编辑、两处保存按钮、刷新后持久化；模拟磁盘写入失败后草稿与选区仍在，刷新恢复并重试成功。未给用户藏书写入测试批注。证据见 `quality/library-annotation-fix.json` 与 `quality/screenshots/library/annotation-fix.jpg`。

2026-10-02 在实际内置浏览器中重传用户此前失败的 138,778,880 字节 PDF，563 页全部转换，生成 563 张原页图和 28,561 个文字块。第 2、26 页未提取到文字，保留原页并标为待检查。实际点击下载得到 316,516,009 字节阅读包，逐项验证 565 份资源的大小与 SHA-256，原 PDF 哈希一致；没有创建 publication/source。记录见 `quality/library-large-upload.json` 和 `quality/screenshots/library/large-pdf-converted.jpg`。这是传输、转换完整性和下载验收，不是所有文字、公式的识别精度验收。

`node features/library/browser-check.mjs` 在独立测试工作空间使用 Edge，验证真实 DOM 选区、行内及独立公式、批注刷新恢复、原页选择、扫描文字、保存回执丢失后重试，以及 1024 像素窗口布局。测试使用现场生成的混合 PDF，没有导入用户材料。证据记录在 `quality/library-browser.json`，截图位于 `quality/screenshots/library/`。

`features/library/metadata.test.js` 验证文件信息优先、封面多作者、标签书目、非法 ISBN 与软件作者过滤、手填覆盖保护、版本冲突、无重转换补识别、书目导出入库往返、EPUB 多作者与译者区分，以及无扩展名存储附件的 PDF 属性读取。实际内置浏览器已给 563 页教材补识别书名、副标题和四位作者；新识别结果和原内容使用同一快照。

`node features/library/performance.mjs` 使用 500 页、5,000 块、10,000 条批注的合成数据。本机一次测试中，领域服务单页读取 P95 约 0.2 ms，热缓存页批注 P95 约 3.6 ms，批注首次索引约 119 ms，检索 P95 约 2.5 ms，单条保存约 7 ms，导出约 0.83 s。原始记录见 `quality/library-performance.json`。这是服务进程测量，不含网络、浏览器 DOM、PDF 渲染或 OCR，不代表真实书籍识别精度。

原有整套应用验收已通过。真实中文教材、公式密集扫描、低清晰度和复杂版式仍需逐页识别精度评估；尚未验证原方案所有 CropBox、旋转、跨页、复杂表格和完整 EPUB 兼容场景。
