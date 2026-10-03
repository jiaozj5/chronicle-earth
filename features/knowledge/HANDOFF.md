# A4 云上体系与来源交付

接口版本：共享契约 1.0。修改范围：仅 `features/knowledge/`。没有增加根依赖；没有创建第二套存储。

## 已交付

- `index.js` / `style.css`：知识与来源两个路由。文稿、概念、观点、问题、论证；连续 Markdown 编辑、安全阅读、表格、公式、可折叠标题目录；明确前提和结论。
- 文稿自有段落稳定 ID；引用块单独保存并可以排序。同一知识项或记录进入多份文稿仍指向原对象。
- 默认固定版本的引用与精确 UTF-16 原文片段；可选择跟随当前版本。新版本提醒、正文差异、主动更新引用、已删除来源提示和恢复跳转。
- 有方向的支持、质疑、定义、前提、实例与对称相关；关系目标类型验证、对称关系去重、反向引用。
- 来源可编辑文本、Markdown、摘录或链接，并导入文件。文本文件读取为可检索正文；其他附件原样保存并保持“未解析”。附件的描述不会冒充解析全文。图片附件可直接预览；外链保留地址与已填写摘录。
- 知识/来源编辑650ms防抖持久化统一 Draft；切换等待草稿保存；刷新自动恢复；正式内容与草稿软删除在同一事务中提交。草稿不点亮地图、不自动进入正式知识。
- 并发冲突保留旧编辑基准和本地文字，显式比较后才能以新版本继续合并；正式提交丢失响应后重试复用完整原始变更集。
- 库目录与引用选取先查摘要，选中后读取原文；反向引用扫描只获取非文稿对象元数据与文稿引用块。

## 公共服务

`service.js` 导出：

- `validateCitation(ref, object, allowedSourceRefs?)` → `{valid,code,message,text,warnings}`，不抛异常；校验身份、固定版本、原文、片段、文稿段落、定稿消息讨论归属与允许来源版本。页码没有可核验页文本时拒绝定位，不回退到全文。
- `validateKnowledge(data)` / `validateDocument(data)` / `validateSource(data)` / `validateRef(ref)`，无效时抛共享 DomainError。
- `validateRelation(data,fromObject,toObject)` / `prepareRelationChange(data,fromObject,toObject,existing)` / `relationKey(data)`。
- `referencesIn(object)` / `incomingRefs(targetId,objects)` / `referenceStatus(ref,snapshot,latest)`。
- `prepareAdoptionChange({target=null,objectType='knowledge',data,messageRef,newId})` → 单 change；`prepareUndoChange(current,before,expectedRevision)` → 单 change。只准备，不提交，由 A0 原子编排回执。
- `outlineOf` / `reconcileTextBlocks` / `versionDifference`。

人物原文核验使用唯一的 `validateCitation`。A5 不应在核验失败后自行寻找相似句替代。

## 草稿字段与协作

统一 Draft 数据：`{draftKind:'knowledge'|'sources',targetType,editingId,editingRevision,title,body,content:完整业务内容}`。`editingRevision` 固定原始编辑基准，恢复不偷换成当前版本。

壳提供的 `api.list({objectType:'draft',draftKind:mode})` 已接通。A0 已给史书隔离这些草稿；全局 Draft 导航按 `draftKind` 分派到本模块。

## 验证证据

- `node --test features/knowledge/service.test.js`：16/16。覆盖 C08、K02–K06、R07、A03/A04 的服务语义；最后一项使用真实 Workspace SQLite，验证固定引用、材料修订/删除、幂等采纳及版本保护撤销。
- `node features/knowledge/browser-check.mjs`：10 条真实 Edge 检查通过。使用隔离临时工作空间、本机 HTTP API、真实 SQLite，不修改用户工作空间。覆盖草稿刷新恢复、提交成功但响应丢失后的幂等重试、表格/公式/目录、跨路由保留、旧基准冲突、固定证据与差异、支持关系、Markdown原附件导入与未解析附件状态。
- 浏览器版本、逐项结果和截图位于 `qa/`；实际页面截图已经查看，1440/1024 宽窗口内容可读，没有未捕获页面异常。
- `browser-check.mjs` 使用本机已安装 Edge 与 Codex 运行时 Playwright。其他机器可设置 `PLAYWRIGHT_PATH` 和 `BROWSER_CHANNEL`；它不是用户运行依赖。

## 未测与边界

- A6 的完整 V1 性能数据、1920与实际浏览器200%缩放、中文系统输入法人工流程、真实用户任务与一周复访尚未由本模块声明通过。
- 真实外部模型讨论由 A5/A0 负责；本模块仅保证来源验证与采纳准备，不声称已完成真实模型质量验收。
- 文稿引用块显示在自有正文之后，可以排序；首版未提供富文本拖动插入到任意句间。
- 日期或人名不会从材料自动推断；链接不自动抓取网页；PDF/OCR等解析不属于已交付能力。
- 目录按批加载；文稿/知识类型与来源解析状态在服务端分页前筛选，目录数量与匹配结果一致。

没有迁移既有对象。来源新增 `attachments` 显示元数据与 Draft 使用上述业务字段，权威附件 ID、版本和备份沿用 A1。
