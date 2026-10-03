# 材料藏书：阅读、批注与 agent 接口方案

日期：2026-10-02。状态：方案 v0.1 已进入实现，运行格式为 `chronicle-reading-1`。已接通书架、阅读、批注、转换任务与 HTTP/MCP；当前能力、实际格式和测试证据见 [材料藏书实现与使用](07-library-implementation.md)。本文保留完整设计目标，不能将后文所有验收项视为已通过。未转换用户真实书籍。

## 1. 选型结论

采用“原始文件 + 结构化阅读内容 + 独立批注”的组合。已有 EPUB 3 保持 EPUB；PDF 保留原 PDF，并生成可校对的结构化副本。图书馆、书架和阅读桌是这些资料的不同入口，使用同一套内容与批注。

不要求把所有 PDF 强制转成 EPUB，也不自行设计文字排版或公式语言。项目需要制定的是原页、结构化文字、批注之间的对应规则，以及统一操作接口。这一组合的产品集成需要开发；没有核实到一个单独格式或现成组件可直接覆盖全部要求。

| 部分 | 采用或优先评估 | 边界 |
|---|---|---|
| 可重排电子书 | EPUB 3.3 / XHTML / CSS / MathML；评估 Readium Web | EPUB 是书籍容器；不会自动提供本项目的批注数据库和 agent 操作 |
| PDF 原版阅读 | PDF.js | 负责原页呈现及可用文本层；不是扫描 OCR 或公式识别引擎 |
| 结构化内容 | 项目统一 JSON 模型；受控 HTML 渲染；复用本地 KaTeX | 可选中正文与显示 DOM 必须建立明确映射 |
| PDF 结构化转换 | 优先验证 Docling；MinerU 作为对照适配器 | 根据实际中文、公式、双栏、扫描样本评估，不能仅凭宣传确定准确率 |
| 扫描件可搜索副本 | 可选 OCRmyPDF | 增加 OCR 文字层，不等于恢复章节、表格和公式语义 |
| 批注交换 | W3C Web Annotation JSON-LD + 有命名空间的项目扩展 | 通用工具能读正文和目标；不保证通用阅读器呈现全部自定义符号 |
| agent 接口 | 共用领域服务 + 本机 HTTP API + MCP 适配 | MCP 提供协议；具体阅读、标记、撤销等工具由项目实现 |

EPUB 支持 XHTML、SVG 和 MathML；具体阅读器仍需验证兼容性。[EPUB 3.3](https://www.w3.org/TR/epub-33/)

Readium Web 的官方页面目前列出 EPUB 支持，PDF 属于后续计划。因此本方案为 PDF 单独采用 PDF.js。[Readium Web](https://readium.org/web/)、[PDF.js](https://mozilla.github.io/pdf.js/)

Docling 提供 OCR、表格结构、公式识别及图片输出配置；转换时应保留 JSON 和图片，不能只保存 Markdown。[Docling 配置](https://docling-project.github.io/docling/reference/pipeline_options/)、[Docling 文档模型](https://docling-project.github.io/docling/reference/docling_document/)

MinerU 可输出结构化内容，但入口及版本不同，返回的 JSON 不一定是同一种中间模型；适配器必须固定版本及输出契约。[MinerU 输出契约](https://opendatalab.github.io/MinerU/reference/output_files/)

## 2. 阅读体验

- 图书馆入口：书架、封面、作者、分类、搜索、导入进度、最近阅读与批注数量。书架分类与阅读进度不改变书籍正文或来源版本。
- 阅读桌：目录、正文和可收起的批注侧栏。选中文字后直接出现高亮、下划线、符号、批注操作；支持键盘、撤销、重做、跳转原页。
- 原版视图：保持 PDF 的页、图、公式及版面，以文字层完成选择；图片或无法可靠识别的公式可作区域批注。
- 重排视图：调整字号、行距和宽度，以结构化内容精确选择、检索和批注。按需显示对应原页，支持并排校对。
- 两种视图共享批注身份。有精确映射时同步定位；只有块级映射时显示整块范围并注明精度，不能伪装成逐字对齐。
- 公式可整式选中；复制时提供 LaTeX、MathML 或原图。任意子公式选择需要表达式树及符号映射，不能用普通拖选假装已经支持。
- 保存状态区分“正在保存”和“已保存”。断线、版本冲突和识别失败时保留当前输入及批注。

## 3. 阅读包与文件组织

名称暂定“藏书阅读包 v0.1”，它是项目的开放组合规范，不是新的国际电子书标准。运行时仍由现有 Workspace 和附件系统保存权威数据；目录结构仅描述便携导出。使用普通 ZIP，建议名称 `书名.book.zip`，不另造封闭二进制格式。

```text
manifest.json                   包版本、书目、资源清单、每项 SHA-256
original/book.pdf               导入的原 PDF，或原始 EPUB / 图片
publication/structure.json      块、阅读顺序、公式、表格、图片关系
publication/text/<block>.txt    每块的规范文字，供稳定定位
publication/chapters/*.xhtml     可选的重排呈现，由结构生成
publication/math/*              LaTeX / MathML，识别结果与校对状态
assets/*                       原始图片、公式裁片、页面预览
mapping/pages/*.json            原页几何、文字区间、坐标变换
annotations/annotations.jsonld  批注正文、目标、符号、版本与来历
conversion/report.json          引擎版本、参数、覆盖率、失败及待校对项
```

清单中的路径是包内相对路径；导入时拒绝绝对路径、`..`、重复条目和超限解压。图片、字体及原文件随包保留，不依赖临时网页 URL。所有被引用资源都进入现有附件引用及完整备份；不能只记一个外部磁盘路径。

允许导出标准 EPUB 3 作为阅读副本；批注同时导出 JSON-LD。原页坐标、转换历史和某些符号无法在普通 EPUB 阅读器中完整还原，不能把 EPUB 单文件宣称为无损完整备份。完整迁移使用阅读包或现有工作空间备份。

### 3.1 身份与版本

| 字段 | 含义 |
|---|---|
| `publicationId` | 本书在藏书中的稳定身份；标题或书架改变不换 ID |
| `sourceRef` | 现有 Source 的固定 `{targetId, revision}`，用于追溯原材料 |
| `sourceSha256` | 原始文件字节摘要；不同文件或版本不能误认为相同原件 |
| `renditionId` | 某次转换或人工修订产生的不可变内容快照 |
| `blockId` | 该快照中段落、公式、图片或表格的身份，不使用数组序号 |
| `resourceUri` | 某个不可变块文字或原页图的完整 URI；导出后可通过清单解析 |
| `annotation.id` / `revision` | 批注自己的身份与修订；加批注不产生全书正文新版本 |

重新 OCR 或修正正文生成新 `renditionId`。尽量通过显式对应表沿用已确认块身份；拆分、合并或无法匹配的块记录新旧关系。旧快照、原件和旧批注目标保留。书目修改、转换修订、批注修订分别计版。

### 3.2 结构化内容

每个块至少保存 `blockId`、`kind`、`resourceUri`、`canonicalText`、`sourceRegions`、`recognition`；文档另有有序 `readingOrder`、目录树及资源清单。

- `kind` 包含 heading、paragraph、list-item、formula、figure、table、caption、footnote；页眉页脚另标 furniture，保留但默认不混入正文。
- 普通文字通过有序 inline runs 保留强调、链接与脚注关系。正文块可以引用行内公式对象。
- 公式保存 `latex`、可选 `mathml`、`originalCropAssetId`、`display=inline|block`。LaTeX 的可编译性与识别内容正确性分开记录；渲染失败时显示原裁片。
- 图片保留资源、原页区域、图注和可选说明。自动生成的图片说明单独标记为推断，不替代图本身或原图注。
- 表格保存行列、单元格、合并关系和每个单元格的规范文字；复杂表格同时提供原图。禁止把跨单元格选择扁平化成一个可能错序的句子。
- `recognition` 保存方法 native-text / ocr / manual、引擎及版本、可用时的置信度、校对状态。没有可信分值时为 null；不同引擎分数不直接比较。
- 校对状态至少为 unreviewed、verified、corrected、needs-review。语义识别与几何对齐各自记录状态。

原 PDF 文本提取结果也可能存在乱码、字体映射、连字和阅读顺序问题，不能因为“能复制”就自动标 verified。

## 4. 精确选中与定位规则

### 4.1 文字锚点

每次保存文字批注同时保留：不可变块资源 URI、`renditionId`、`blockId`、起止位置、精确引文、前后文。检索可以使用宽松归一化索引，权威引文不能使用模糊匹配或搜索结果的归一化文本。

1. 每块规范文字保存为 UTF-8、Unicode NFC，换行为 LF。生成后冻结；选中时不再次执行 trim、空白压缩或 NFKC。
2. 规范文字在导入阶段由逻辑阅读顺序生成，移除排版标签、解码实体。断行合并、断词和页眉处理都保留原始文字与映射；不确定处保留并提示。
3. 对外 `TextPositionSelector` 使用 Unicode code point，半开区间 `[start,end)`；交互边界不能切开 grapheme cluster。现有引用契约使用 UTF-16，接入时必须显式转换，不能沿用相同数字。
4. 浏览器 DOM Range 的 UTF-16 位置通过 source map 转成规范文字位置；点击工具栏前冻结该选择和快照身份。新行折行、字号变化不改变保存位置。
5. 混排正文中的公式或图片用一个 U+FFFC 原子占位，另外保存原子位置与对象 ID。复制/agent 读取按原子关系展开公式或图片信息，不从 KaTeX DOM 的 `textContent` 重建正文，避免视觉层和辅助 MathML 层重复。
6. 整个公式的批注直接指向公式对象。跨公式选择包含相应原子；首版不声称提供任意公式内部符号选择。
7. 跨段落、跨页、跨单元格选择保存有序片段列表，每段单独校验。W3C 多 target 本身不表达顺序；项目用 `cr:segmentIndex` 与分组扩展表达连续选择，通用客户端仍可理解各段目标。
8. 保存时校验 `sliceByCodePoint(canonicalText,start,end) === exact`，同时校验 ID、快照及可用的前后文。重复引文不能只靠 `indexOf` 找第一个结果。
9. 旧快照引用始终定位旧快照。迁移到新 OCR 结果属于显式操作；返回 exact、ambiguous、unresolved 等状态，含糊结果等待校对，不能悄悄改绑。

W3C 规定文字选择按 Unicode code point 计数，并定义引文、位置和上下文选择器；上述块冻结及严格校验是项目额外约束。[Web Annotation 文字定位](https://www.w3.org/TR/annotation-model/#selectors)

### 4.2 原页几何

- 页面 ID 独立于印刷页码；机器 `pageIndex` 从 0 开始，用户页码或罗马数字放在 `pageLabel`，不混用。
- 规范坐标以经过裁剪及页面固有旋转后的可见页面为参照，左上角为原点、向右/向下为正，范围 `[0,1]`。记录源 PDF CropBox、旋转、页面尺寸和可逆变换。
- 文本高亮保存每行 quadrilateral 列表，不能以一个大矩形覆盖双栏或多行中间的无关内容。
- OCR 纠偏、裁边或展平后必须保存对应变换。无法精确逆映射时降低对齐等级，不把处理后图片坐标直接贴在原 PDF 上。
- 区域标记保存 page resource URI、页标识、形状及规范坐标；对外区域选择可生成指向该页图的 `SvgSelector`。
- SVG selector 表达“选中哪块区域”；标记颜色、对号等“如何绘制”属于独立样式，不能把二者混为一谈。
- 导入器只有块级框时，不按等宽字符猜逐字框。可在重排视图准确选字；原页显示块级关联，或补充带词/字坐标的对齐步骤。

## 5. 批注和所有符号

批注是可独立查询、修订、删除、恢复及导出的对象。正文、符号和关联原文均可由机器读取；不能只把它们烧录到截图或 PDF 页面中。

| 用户操作 | `mark.type` | 定位 / 显示原则 |
|---|---|---|
| 高亮 | highlight | 随文字范围逐行绘制 |
| 下划线 | underline | 随文字范围逐行绘制 |
| 方框 | rectangle | 围住选中对象或用户指定区域 |
| 三角形 | triangle | 可作边注图标或区域形状，保存明确 placement |
| 实心点 | filled-dot | 绑定文字、对象或页内点 |
| 空心圈 | hollow-circle | 小型标记符号，尺寸随标记保存 |
| 大圆圈 | circle | 围住目标内容或区域，保存圆/椭圆几何 |
| 叉号 | cross | 显式符号，可加文字说明 |
| 对号 | check | 显式符号，可加文字说明 |
| 斜杠 | slash | 显式线段，保存方向 |

共同字段：`type`、`placement=text|margin|enclose|free`、颜色、透明度、线宽、可选几何及尺寸。正文批注与符号可组合，也允许只有符号；对号不自动表示“事实已验证”，叉号不自动创建 refutes 关系，语义由用户文字或标签说明。

文字关联标记在重排后重新计算显示位置；自由几何固定在原页。自由画的大圆圈切到重排视图时，以批注卡片和关联对象显示，除非有可靠映射，不拉伸圆圈去包围重排后的文字。

交换格式采用 W3C Annotation、TextualBody、SpecificResource、TextQuoteSelector、TextPositionSelector、SvgSelector。项目扩展使用显式 `cr` 命名空间，未知扩展应保留，不能静默丢弃。[W3C Web Annotation](https://www.w3.org/TR/annotation-model/)

附带 [批注示例](library-reader/annotation.example.jsonld) 和 [示例目标文字](library-reader/selection.example.json)。这些是人为构造的格式示例，不是转换结果。示例中书本 emoji 占一个 code point、两个 UTF-16 code units，专门展示不能混用偏移单位。

导出内容必须包括批注 ID、作者及时间、批注文字/标签、符号、目标身份与版本、精确引文、上下文、原页位置（若可用）、识别/校对状态。图片和公式目标导出实际资源引用及可用的 LaTeX/MathML，不能只给一段自动摘要。

## 6. PDF 与扫描书转换

```mermaid
flowchart LR
  A[导入 PDF / EPUB / 图片] --> B[原件保留与摘要校验]
  B --> C[逐页检测文字与版面]
  C --> D[原生文字提取 / OCR / 公式与表格识别]
  D --> E[统一块模型及原页映射]
  E --> F[原版与重排并排校对]
  F --> G[发布不可变阅读快照]
  G --> H[阅读、批注、检索、agent]
```

### 6.1 路由

1. 先保存原件与书目，允许立即打开原版。解析后台进行，不阻塞材料入库。
2. 原生文字 PDF：优先提取已有文字和坐标，检查阅读顺序、字符映射和文本覆盖；仅对异常区域补 OCR。公式仍需专门结构化。
3. 扫描 PDF：页面方向和倾斜检测、版面分析、OCR、阅读顺序、公式与表格识别；保存图片、裁片、文字位置和过程信息。
4. 混合 PDF：逐页甚至逐区域选择路径。不能因为某页已有少量文字就跳过整页扫描主体，也不能对全书重复 OCR 造成双文字层。
5. EPUB：读取 spine、目录、XHTML、图片和 MathML，保留原资源及相应定位。已有高质量内容无需重新 OCR。[Readium Locator](https://readium.org/architecture/models/locators/)
6. 统一转换为项目模型；Docling/MinerU 原始结构也随转换报告保留，适配器负责字段、单位、阅读顺序和质量状态转换。

OCRmyPDF 可用于生成带文字层的副本，但官方说明其 OCR 有识别和阅读顺序限制，且不会提供完整文档结构。因此它不单独承担本项目的科学书籍转换。[OCRmyPDF 说明及限制](https://ocrmypdf.readthedocs.io/en/latest/introduction.html)

### 6.2 正确性和失败处理

“显示保真”“文字识别正确”“公式语义正确”“选择与画面对应”是四个独立指标。保留原 PDF 可以支持检查原版，但不是对所有文件渲染绝对正确的保证。

- 图和公式原裁片始终可看。识别出 LaTeX 后并排对照原图；渲染成功不能证明公式认对，尤其要检查负号、上下标、希腊字母、积分上下限与矩阵。
- 不可靠公式可以继续以原图阅读、区域批注；对 agent 返回 needs-review 和裁片，不能冒充已验证数学表达式。
- 字符坐标不足时不宣称原页逐字精确选择。提供块级选择及重排文字选择，补充对齐后升级能力。
- 导入报告记录总页数、成功/失败/待校对页、图片及公式资源、异常阅读顺序；允许部分完成，不能用全书 ready 掩盖局部失败。
- 批处理支持按页缓存、断点续跑、取消、失败重试。缓存键至少包含原文件摘要、引擎/模型版本、语言与转换参数；转换不应运行在主 HTTP 请求线程中。
- 默认本机转换。首次模型下载、硬件要求及磁盘占用在部署时实测；模型准备完后可离线运行。云端转换若后续需要，作为用户明确选择的适配器，不自动上传书籍。

现有官方组件提供能力，不提供针对用户藏书的准确率保证。尚未收到或转换真实样本；最终引擎选择及性能承诺要由第 10 节的样本验收决定。

## 7. agent 接口

UI、HTTP 和 MCP 调用同一套领域服务；不能让 agent 直接改 SQLite 或依赖屏幕坐标点击。使用 MCP 官方 SDK 实现协议和工具 schema；协议版本随部署固定、协商。MCP 支持 JSON Schema 输入、结构化结果和资源链接。[MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Docling 已有 MCP 服务用于文档转换与处理，可以复用或作为适配参考；它不能自动实现本项目的图书馆、批注和撤销语义。[Docling MCP](https://github.com/docling-project/docling-mcp)

以下为拟实现工具名，当前服务器尚未提供：

| 范围 | 工具与必要行为 |
|---|---|
| 能力 | `library_capabilities`：版本、支持格式/标记/定位精度、转换器可用状态 |
| 藏书 | `library_list`、`library_import`、`library_update_metadata`、`library_move`、`library_remove`、`library_restore` |
| 转换任务 | `import_status`、`import_cancel`、`import_retry`；返回 jobId、逐页状态和问题清单 |
| 阅读 | `book_outline`、`book_read`、`book_search`、`book_get_asset`；按章/页/块分页，返回准确目标和覆盖状态 |
| 定位 | `selection_resolve`：验证快照、位置和引文，返回 exact / ambiguous / unresolved；含糊时不写入 |
| 批注 | `annotation_create`、`annotation_get`、`annotation_list`、`annotation_update`、`annotation_delete`、`annotation_restore`；覆盖全部标记 |
| 原文与批注联读 | `annotation_read_context`：同时返回原文、前后文、原页、公式/图片资源、批注和校对状态 |
| 校对与版本 | `book_correct`、`book_compare_renditions`、`annotation_reanchor_preview`、`annotation_reanchor_apply`；先返回可检查差异，使用显式版本写入 |
| 导出 | `book_export`、`annotation_export`、`annotation_import`；报告缺失资源、未知扩展及兼容性损失 |
| 阅读状态 | `reader_get_state`、`reader_open`、`reader_navigate`、`reader_set_selection`、`reader_set_view`、`reader_set_preferences`；指定会话，未打开阅读器时返回可恢复状态 |
| 历史 | `operation_undo`、`operation_redo`；精确引用操作回执，检查是否已有后续修改 |

### 7.1 共同请求与响应约束

- 读操作显式指定 workspace、publication 及 rendition；搜索结果返回可验证的块范围、exact 引文及截断标志。
- 写操作要求 `requestId` 和目标 `expectedRevision`，创建用 0；响应丢失重试幂等，相同 requestId 不同载荷返回冲突。批量操作定义全成功或逐项结果，不能含糊。
- 工具参数有 JSON Schema；结果为有 schema 的结构化数据。长正文通过 cursor、limit 和资源 URI 分块读取，不能每次把整本书塞进上下文。
- 读取公式同时返回表示、原图引用和校对状态；读取区域批注可返回区域裁图及经过标注的 OCR 候选，不把候选当作精确引文。
- 区分范围校验通过与 OCR 语义正确。读取响应至少包含 `anchorStatus`、`recognitionStatus`、`coverage`、`warnings`。
- 统一错误包括 VERSION_CONFLICT、IDEMPOTENCY_CONFLICT、TARGET_UNRESOLVED、TARGET_AMBIGUOUS、RENDITION_UNAVAILABLE、RESOURCE_MISSING、CONVERTER_UNAVAILABLE、UNSUPPORTED_OPERATION。
- 本机保留现有 Host/Origin 和会话保护；外部 agent 通过明确工作空间与读写权限连接。书籍内容是资料，不能作为工具执行指令。导入 HTML/SVG 采用受控渲染，禁用脚本及任意网络资源。
- UI 临时选区不等于持久化批注；修改阅读视图不修改正文；删除批注不删除来源。

## 8. 对现有工程的接入

已经核对的现状：

- `features/knowledge/index.js` 的导入只把 TXT/Markdown 自动读成正文，其他文件作为附件保存。当前选择引用用 textarea 的 UTF-16 范围。
- `features/knowledge/service.js` 已有固定版本、精确片段与页文本的引用校验，但来源块定位、区域定位和批注对象尚未实现。
- `packages/ui/index.js` 提供受控 Markdown 与 KaTeX 渲染；显示 DOM 尚没有完整的正文位置映射。
- `packages/workspace/index.js` 提供 SQLite 事务、修订、附件和备份，应该继续复用；批注和阅读包不另建权威数据库。
- `apps/server/main.js` / `apps/client/api.js` 已有本机 HTTP 能力；当前没有藏书 MCP 服务。

拟新增 `features/library/` 负责书架、阅读器、定位、批注及转换适配；保留 `features/knowledge/` 的知识编辑与跨材料关系职责。来源详情连接至阅读器。外观设计与转换服务可独立迭代，但共享 publication/annotation 规则。

拟扩展对象类型 `publication`、`annotation`、`importJob`；共享契约、服务端校验、工作空间摘要、附件引用、搜索、备份及恢复同时升级。大规模页/块数据作为有清单及哈希的不可变附件分片，避免把整本书内嵌到每一次对象修订中；索引是可重建的派生数据。

现有 Source.body 与 UTF-16 CitationRef 保持原语义。新引用采用有版本标签的 locator，由共同验证入口分派；不能静默重解释老偏移。书籍检索供人物使用时返回固定 rendition 与块引用；若需要生成兼容正文投影，必须保存投影到块的映射。

当前 `parseStatus=ready|unparsed` 不足以表达局部失败和待校对；新增结构化覆盖状态，并同步调整人物资料覆盖和检索逻辑。没有校验过的图片或公式不得以“全文已读”出现。

## 9. 实施次序

1. 用样本验证转换器、MathML/KaTeX 显示和映射粒度，固定依赖版本、许可证清单及转换配置。
2. 落地不可变内容快照、文字/区域锚点、批注对象及往返导出；先验证精确定位再做书架外观。
3. 接入 PDF 原页和重排阅读，完成全部标记、批注侧栏、撤销、恢复和历史版本行为。
4. 接入后台转换、部分失败、校对和重转换；加入 EPUB 导入及兼容阅读。
5. 对同一领域接口封装 HTTP/MCP，验证 agent 与人工操作的数据一致性；最后完成图书馆场景和规模性能验收。

当前已完成核心阅读链路及合成样本验证；真实藏书的识别质量评估和 Docling 模型验证仍待完成。实现采用统一内容 DOM，并保留原 EPUB；尚未集成完整 Readium 排版引擎。详细差异以实现文档为准。

## 10. 验收要求

| 维度 | 必测案例及通过条件 |
|---|---|
| 选中准确性 | 中文、emoji、组合字符、英文连字、双栏、脚注、跨段/跨页、表格、公式混排；UI、复制、存储、API 返回的区间一致 |
| 原页对齐 | 缩放、旋转、非默认 CropBox、扫描纠偏；重复引文不误绑；块级定位明确显示粒度 |
| 标记 | 全部十种标记均可创建、读取、改样式、删除、恢复、撤销；刷新与导出导入后保留语义和位置 |
| 公式与图片 | 原图不缺失，公式识别对照可见；渲染失败有原图回退；不把错误公式标为已校对 |
| 扫描转换 | 正常扫描、歪斜、低清晰度、横竖排/双栏、原生与扫描混合页；输出缺失、错序、低质量均可发现并重试 |
| 版本 | 重 OCR、修正文、换字号、换视图后不悄悄漂移；原历史批注仍能回到原快照 |
| agent | 所有 UI 持久化操作有对应工具；能独立取出批注、准确原文、公式/图片及出处；幂等、冲突及未定位状态正确 |
| 规模 | 500 页书、10,000 条批注的初始打开、翻页、检索、标注和导出；按页/章虚拟化，整本书不常驻 DOM |
| 可靠性 | 转换进程中断、取消、磁盘不足、缺附件、备份恢复；无静默数据丢失，无整本书误标成功 |

建议交互目标：已载入页面上选区/标记反馈 P95 不超过 100 ms；保存状态立即反馈，持久化耗时单独测量。打开和转换耗时按机器、冷/热启动、页数和引擎分别报告。以上是待验证门槛，不是本轮测量结果。

首轮建议由真实藏书挑选四类样本：原生中文书、公式密集教材/论文、普通扫描书、较差扫描或复杂版式书。每类抽取含文字/图片/公式的代表页，报告字符错误率、关键公式错误、阅读顺序和定位误差；原始对照与人工判定一起保留。未通过时保留原版阅读和区域批注，限制其结构化能力，不能隐藏失败。
