# A3 交接（2026-10-01）

## 2026-10-02 地图主体与自定义地点修订

- `mount(container,{layout:'map',...})` 让地图填满宿主宽高；时间、地点搜索放在 300px 可折叠浮动工具栏，图层和地点管理默认收在 `details` 内。省略 `layout` 保持普通窄栏宿主兼容。主应用的宿主尺寸由根壳负责。
- 地名和聚合计数全部直接绘制浅色文字，没有矩形底色。选中地点保留双圈与文字勾选，选择状态不单靠颜色。
- 新自定义地点写入 `data.userCreated:true`。`service.js` 导出 `isCustomPlace(place)`：对象类型为 Place 且 ID 不以保留前缀 `place_ne_` 开头；兼容旧版没有标记的自定义 UUID。内置地点即使被写入该标记，也不能绕过前缀保护。服务端复用同一判断并保护内置 ID。
- “管理自定义地点”支持名称/别名搜索、删除前展示关联记录数、软删除与恢复。只改 Place 版本，Entry 正文、版本、地点引用与历史原名完全不变。删除时从当前地图选择里移除此地点，恢复后同一地点 ID 的探索重新出现。内置城市不会列入管理界面。
- `ctx.onSelection(selection,{reason})` 的 reason 为 `place`、`time`、`selection` 或 `delete`。初始化、refresh 和 setContext 不触发 callback；主壳可仅在用户导航时展开阅读面板。
- 26/26 atlas 单测通过；原 `browser-check.mjs` 与 `operations-browser.mjs` 真实 SQLite / HTTP / Edge 回归通过，图层管理、路线/地区绘制、旧名、保存、恢复投影均保留。
- 新 `node features/atlas/tests/refinement-browser.mjs` 在 `.test-data/atlas-refinement-1eavbR` 独立工作区通过。核验地图填满 1280×820、工具宽 300px、Canvas 标签没有背景矩形调用、首次挂载不发布选择、新旧自定义地点识别、排除内置城市、删除计数、删除/恢复后 Entry 完整对象不变、探索移除/恢复、深浅色与 390px 宿主截图。还检查真实应用壳首次地图展开、点击地点打开目录、手机目录按钮不遮挡浮动工具。0 浏览器异常；全部六个截图已查看。测试没有访问 `.local` 用户数据库。手机壳顶部真实高度与地图剩余高度的调整交根壳处理。

实现仅修改 `features/atlas/`。公共实现契约 1.0，无新增根依赖或存储层。

## 已交付

- 唯一时间模块 `time.js`：年/月/日，BCE/CE 无显示零年，范围/不确定/开放边界，公元前 10000—公元 10000 年索引，保留未知与越界原文，半开日区间相交。明确非法日期抛 `DomainError('INVALID_INPUT', ..., {field:'occurrenceTime',reason:'INVALID_TIME'})`。
- `service.js`：探索资格、按时间查询、多个时间层并集、地点/全域 ID 去重、临时过滤与探索分离、删除/移动后的纯重建投影、旧名候选检索、屏幕聚合及标签碰撞避让。
- `index.js`/`style.css`：本地真实地理地图、平移缩放、城市聚合入口、选择状态、地点/别名搜索、多地点、保留所选历史原名、自定义文本/大致定位地点、命名时间图层保存与选择、清除时间、静止淡雾与点亮、地图视野保留、底图失败时文字选择仍可用。
- `view-operations.js` 及管理界面：图层改名、软删除、拆分、合并原子提交，只改变 TimeView。拆分输入年/月/日均由唯一时间模块解析，以该时间单位第一天为后段开始，前后两段无重叠、无缺口。合并相接或重叠图层；不连续的图层明确拒绝，避免把空白时期误并入范围。拆分和合并以新图层替换所选图层（旧图层软删除），保持所有 Entry ID、正文和修订不变。
- `geometry.js` 及绘制界面：地区与路线支持地图依次点选、撤回上一个点、结束/取消、可编辑经纬度列表。方向键移动地图，Enter 取地图中心，Ctrl+Enter 结束，Escape 取消；绘制中仍可拖动及缩放。路线保存 GeoJSON LineString，地区保存封闭 Polygon；无效坐标、点数不足、零面积和交叉边界给出错误。刚创建并选中的范围以灰色虚线预览，只有正式记录关联该范围时才点亮，不点亮内部或沿途城市。
- 图层管理、地图及表单跟随全局深浅色；268px 内容栏内换行、不横向溢出。
- 随包 Natural Earth 陆地/河流、2524 个导航城市、D3 7.9.0（许可证一并保留）。种子导航不产生探索。

## 公共接口

`parseTime(text)`、`toRange(spec)` → `{startDay,endDayExclusive,indexed,reason?}`、`overlaps(a,b)`、`formatTime(spec)`。

`projectAtlas(entries,places,timeSpec,options={})` → `{markers,total,visibleTotal,explored,unlocatedCount}`。

每个 marker 包括 `{placeId,name,kind,coordinates,geometry,recordCount,visibleCount,explored,entryIds,visibleEntryIds}`。过滤 options 的 `q/kind/placeIds` 只改变 visible 数据。`matchedEntryIds` 可选数组或 Set，提供时替代本模块正文 q 扫描，支持服务端全文检索后只传递 Entry 元数据；空数组表示无匹配，探索总数不受影响。null timeSpec 表示全部已索引时期；TimeSpec 数组按记录 ID 并集。

`mount(container,ctx)` → `{refresh,setContext,dispose}`。ctx.api.atlas 接收 `{time:JSON.stringify(TimeSpec)}`，无过滤时省略 time；地点/时间更改调用 `ctx.onSelection`。地点选择是导航，不会写入记录；自定义地点及时间视图经真实 `ctx.api.commit` 保存。

## 验证

1. `node --test features/atlas/time.test.js features/atlas/service.test.js features/atlas/view-operations.test.js features/atlas/geometry.test.js`：24/24 通过。覆盖 T01/T02、C01—C05 服务语义、M01/M02/M04/M05 局部逻辑，公元前跨公元拆分、半开区间无空隙重叠、拒绝有空隙的合并、范围几何与独立探索尺度、元数据 ID 筛选。一万同城记录仅生成一个城市标记；本轮单次约 44 ms，仅为局部测试观察，不冒充 P95 性能验收。
2. `node features/atlas/tests/browser-check.mjs`：真实 SQLite + HTTP + Edge headless，独立临时工作区。通过旧名选择且保留原名、图层过滤、真实记录保存与点亮、非法日期反馈、图层保存/复选、清空时间过滤、自定义文本地点及多地点。无浏览器异常。
3. `node features/atlas/tests/operations-browser.mjs`：真实 SQLite + HTTP + Edge headless，独立临时工作区。通过图层改名→拆分→合并→删除后原 Entry 完整对象（含版本和正文）保持相同、路线真实指针绘制/撤回/结束、区域绘制/Ctrl+Enter、地图中心取点/Escape、GeoJSON 持久化后只点亮区域 ID、268px 栏宽无溢出，0 浏览器异常。
4. 证据：`quality/browser-check.json`、`quality/operations-browser.json`、`quality/atlas-desktop.png`、`quality/atlas-world.png`、`quality/operations-light-268px.png`、`quality/operations-dark-268px.png`；深浅色和窄栏截图均已视觉检查，文字、范围与选择可辨认。

Windows 当前 PowerShell 进程启动可能挂起，测试使用 exec_command 的 `shell:'C:\\Windows\\System32\\cmd.exe',login:false`。浏览器测试需开发机已有 Playwright，可配置 PLAYWRIGHT_PATH、PLAYWRIGHT_CHANNEL（默认 msedge），不是用户运行依赖。

## 真实依赖与限制

持久化与 HTTP 依赖已接真实 A1/A0，无模拟回答、模拟保存或虚构地理。地理为当代导航参考，不承诺历史边界/海岸。中文旧名只是候选，不能自动认定迁址前后同一身份。

地区/路线绘制及图层改名、删除、合并/拆分已补齐。合并仅接受相接或重叠的连续范围；分离的范围可各自保存、切换，但当前管理界面不把它们保存为单个不连续图层。新增地区和路线可绘制或直接编辑经纬度，已保存地点暂没有重绘入口。当前地图不提供历史国界，也不把相邻、包含关系解释为用户已经关注。

全局 G4、100 次真实交互 P95、200% 缩放、底图加载故障、键盘完整任务及一周真实用户复访，交 A6 独立验收；本交接不能代替这些结果。
