import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const plan=await readFile('docs/03-acceptance-plan.md','utf8');
const rows=[...plan.matchAll(/^\| ([CRTMKNADP]\d\d) \| ([^|]+) \|/gm)].map(m=>({id:m[1],requirement:m[2].trim()}));assert.equal(rows.length,55);
const evidence={unit:'quality/unit-tests.tap',integration:'quality/acceptance-latest.json',cloud:'quality/cloud-ui-latest.json',knowledge:'features/knowledge/qa/browser-results.json',atlas:'features/atlas/quality/operations-browser.json',chain:'quality/full-chain-latest.json',shell:'quality/shell-latest.json',performance:'quality/performance-latest.json',recheck:'quality/performance-recheck.json',uiPerformance:'quality/performance-ui.json',modelPlan:'tests/fixtures/real-model-evaluation.json'};
try{const shell=await readFile('.test-data/shell-1790847471968/report.json','utf8');await writeFile(evidence.shell,shell);}catch{}
const status={
 C01:['自动化验证', 'unit,integration','多地点去重、重叠时间并集及原ID；UI多选另见Atlas验收。'],
 C02:['自动化UI验证','unit,atlas','真实SQLite/HTTP/Edge图层改名、拆分、合并、删除；原记录ID、版本、正文不变。证据由A3提供并审阅。'],
 C03:['自动化验证','integration','HTTP迁移时间/地点，旧投影撤销，新投影出现。'],
 C04:['自动化验证','integration','删除最后合格记录、恢复原ID，投影同步。'],
 C05:['自动化验证','integration','全文筛选0结果仍保留探索，未记录地点不点亮。'],
 C06:['自动化验证','unit,integration','提交/采纳三次重放；不同载荷拒绝；后续引用变化仍重放原回执。'],
 C07:['自动化验证，UI覆盖部分','unit,integration,knowledge','六类真实SQLite/HTTP过期写入冲突；文稿UI另验证编辑内容保留，未逐一走六类冲突UI。'],
 C08:['自动化验证','unit,integration,knowledge','固定原文旧版本，材料更新提示及差异。'],
 C09:['自动化验证','unit,integration','100项暂停索引，真实正文仍可读；水位落后可辨，恢复5秒内收敛。'],
 R01:['自动化验证','unit,integration','全局入口一句正文提交；不要求标题、分类、来源。'],
 R02:['自动化验证','integration','无时空记录保存检索；补齐仍原ID，无资格不点亮。'],
 R03:['部分验证，真实IME待人工','unit,integration','中文大段fill/换行/合成composition不误提交；未代替Windows真实中文输入法与撤销行为验证。'],
 R04:['跨路由/归属已验证；精确锚点部分','unit,knowledge,chain','真实UI在南京1850起草、切换上海1851、跨云上返回后正文/归属不变；引用返回保持对象版本。精确选区与长文滚动锚点仍需人工细测。'],
 R05:['自动化验证','unit,integration,cloud','史书、来源草稿实际持久化后刷新恢复；知识文稿见知识模块浏览器证据。'],
 R06:['自动化验证','unit,integration,performance,shell','中文正文和时空/类型查找、删除默认隐藏、草稿显式查询；CtrlK全局跨类型检索有root浏览器证据。'],
 R07:['自动化UI验证','unit,knowledge,chain','三条实际史书记录编入同一文稿，逐条固定原ID/v1，自有正文独立；点击原记录并返回文稿通过。'],
 R08:['自动化验证','unit,integration','预言首次版本、修订及固定版本评估，时间经过不改身份。'],
 R09:['自动化验证，真实讨论待测','integration,cloud','无来源个人解释可保存；协议桩讨论不代替真实模型对矛盾观点的处理。'],
 R10:['自动化验证','unit,integration,cloud','新建及修改型采纳、重试、撤销、过期目标、后续编辑保护。'],
 T01:['自动化验证','unit','闰日、无效日期、公元前/纪年边界、开放区间由共用时间库单测。'],
 T02:['自动化验证','unit','duration与uncertain查询相交但展示语义不同。'],
 T03:['自动化验证','unit','原文未知或超出索引范围保留，不虚构日期。'],
 M01:['自动化验证','unit,performance','10000条同城仅一个地点入口，count=10000；目录30条分页。'],
 M02:['算法验证，视觉抽查','unit,integration','标签碰撞和选中聚合有单测，普通缩放截图抽查；密集场景全缩放级别人工待测。'],
 M03:['部分验证','integration,performance','独立实底正文，100次普通/长文打开；地图与目录滚动完整任务人工待测。'],
 M04:['算法验证，UI部分','unit','历史别名、同名不同ID；迁址候选完整UI尚未独立验证。'],
 M05:['自动化UI与投影验证','unit,atlas','A3真实指针绘制路线/区域、撤回/结束/键盘取消，GeoJSON持久化；区域只点亮自身，不点亮内部城市。'],
 M06:['自动化验证','integration','拦截land.geojson失败，界面提示后仍可保存与查找记录。'],
 K01:['自动化验证','cloud,knowledge','无时空建立文稿，表格、公式、目录真实Edge渲染和保存。'],
 K02:['业务与UI部分验证','unit,knowledge','关系方向合法性与来源→观点支持UI通过；三条材料/反例组合任务待人工。'],
 K03:['业务与固定导航验证','unit,shell','live/pinned独立语义、共享文稿引用块和反向引用单测；固定版本引用URL刷新仍保留revision。'],
 K04:['自动化验证','unit,integration','固定来源删除不级联丢失，旧版本可核验、恢复原ID。'],
 K05:['自动化验证，格式覆盖部分','unit,cloud,knowledge','文本、Markdown、未解析附件有实际保存/UI；链接校验与图片附件模型有单测，图片/链接导入全流程尚未独立走查。'],
 K06:['自动化验证','unit,integration,cloud','采纳带固定消息来源，撤销保护后续编辑，创建/修订幂等。'],
 N01:['完整浏览器链验证；模型为协议桩','chain','一次真实Edge/SQLite/HTTP任务：地图→草稿→记录→观点→冻结讨论→编辑采纳→讨论上下文→观点引用→同一原记录v1；逐段ID/版本核对。真实模型质量另见A07。'],
 N02:['自动化验证','unit,integration','浏览器屏蔽外部网络继续保存/找回，SQLite重开和草稿刷新；真实进程退出后UI整段另待人工。'],
 A01:['自动化验证','unit,cloud','人物名称/诠释/风格/材料与原文分离，UI人物创建保存；形象上传UI未独立走查。'],
 A02:['协议/范围验证；真实模型待测','unit,integration','可检索/未解析/不可用覆盖明确；模型是否按范围回应列入A07。'],
 A03:['协议/核验验证；真实模型待测','unit,integration,cloud','冻结来源版本、原文逐字片段与越界伪引文拒绝；已核验标签有UI。'],
 A04:['自动化协议验证','unit,integration','实际发往loopback服务的载荷检查不含无关私人记录或来源新版本。'],
 A05:['自动化故障验证','unit,integration','未配置、超时、取消、网络/认证、无效输出、失败重试；限额分支代码存在但真实供应商限额未触发。'],
 A06:['自动化验证','unit,integration,cloud','消息稳定身份、未采纳不改史书、原子采纳、撤销、原讨论保留。'],
 A07:['未验收：等待用户配置真实模型','modelPlan','已预注册两个资料人物20项任务及16/20、零伪造原文门槛；没有任何真实模型评分。'],
 D01:['完整基准自动化验证','integration,performance,shell','三次V1备份恢复，98,320修订规范化摘要一致；每次100附件从实际文件重算SHA256；设置真实下载已验证。'],
 D02:['自动化故障注入验证','unit','写前/中/flush/回执故障、附件写故障与重启；未实际耗尽用户磁盘。'],
 D03:['自动化验证','unit,integration','破损/截断/缺附件/高版本拒绝；原工作区不变、导入失败可重试。'],
 D04:['自动化验证','unit','初始化迁移回滚/未来版本保留、索引重建故障、恢复文件交换中断后重开恢复。'],
 P01:['本机目标达成；真实IME与R0待测','recheck','100次按键至下一帧P95 12.80ms；英文键入，不代替真实中文输入法。'],
 P02:['本机目标达成；R0待测','recheck','100次停止输入至真实SQLite和已保存标签：P95 390.56ms，最大413.55ms。'],
 P03:['本机端到端目标达成；R0待测','performance,integration,uiPerformance','100次HTTP持久化P95 20.03ms；补测提交至正确数量与canvas实际绘制后帧100次P95 419.4ms、最大455.2ms。'],
 P04:['本机UI目标达成；R0待测','performance,recheck,uiPerformance','修复前HTTP P95 860.69ms；修复后100次HTTP472.21ms；100次含类型/时段/正文搜索至精确ID目录渲染P95 607.8ms（含180ms防抖）。'],
 P05:['本机绘制目标达成；R0待测','performance,recheck,uiPerformance','修复后100个不同年份HTTP P95 40.23ms；两图层实际canvas像素变化与数量完成100次P95 244.9ms。'],
 P06:['本机UI目标达成；R0待测','performance','100次普通正文P95 288.98ms，100次100KiB长文310.68ms。'],
 P07:['暖机新上下文通过；冷机/R0待测','performance','10次新浏览器上下文至可写（含关闭）P95 2155.79ms；本机服务已运行、OS缓存暖，不能称冷启动通过。'],
 P08:['本机数据/耗时达成；交互/R0部分','performance','500MiB附件、备份总1.77GB：3次导出12.49–14.36s、恢复15.05–15.86s；真实进度回调，未独立测备份期间阅读帧率。']
};
const matrix=rows.map(row=>{assert(status[row.id],row.id);const [result,refs,note]=status[row.id];return{...row,status:result,evidence:refs.split(',').map(k=>evidence[k]),note};});
const report={generatedAt:new Date().toISOString(),totalItems:55,functionalItems:47,performanceItems:8,definition:'自动化验证只表示所列证据，不能把局部测试等同于全部用户任务或所有55项通过。',environment:'Windows 11 Home China, Node 24.19.0, Edge 154, Ryzen 7 H 255 / 16线程 / 31.27GiB；未验证R0普通8GiB设备和SSD类别。',gates:{G3:'真实模型A07未验收；用户选择稍后自行配置',G4:'有可重跑工程证据，仍有表内人工/部分验证项；不宣称55项全部通过',G5:'未开始8人任务与一周复访；没有真实用户反馈'},matrix};
await writeFile('quality/acceptance-matrix.json',JSON.stringify(report,null,2));
const unitTap=await readFile('quality/unit-tests.tap','utf8'),unitCount=Number(unitTap.match(/^# tests (\d+)/m)?.[1]||0);
const text=['# 独立验收结果', '', '本报告映射规格中的 55 项：47 项功能/契约/保存和 8 项性能。自动化通过只适用于该行列明的证据，不等于全部使用任务或所有发布门禁通过。', '', '实测环境为 Windows 11、Node 24.19.0、Edge 154，16 线程、31.27 GiB 内存。未以此冒充 R0 普通 8 GiB 设备。用户选择稍后连接模型，因此真实模型 20 题未执行；8 人任务及一周复访亦未执行。', '', `23 项组合场景见 [acceptance-latest.json](acceptance-latest.json)，4 项云上UI流程见 [cloud-ui-latest.json](cloud-ui-latest.json)，6 步完整链路见 [full-chain-latest.json](full-chain-latest.json)；${unitCount} 项单测记录见 [unit-tests.tap](unit-tests.tap)。完整性能初测见 [performance-latest.json](performance-latest.json)，缺陷修复复测见 [performance-recheck.json](performance-recheck.json)，浏览器实际查询/地图绘制补测见 [performance-ui.json](performance-ui.json)。`, '', '| 编号 | 状态 | 实际证据与边界 |','| --- | --- | --- |',...matrix.map(r=>`| ${r.id} | ${r.status} | ${r.note.replaceAll('|','／')} |`),'','原始机读映射：[acceptance-matrix.json](acceptance-matrix.json)。真实模型题目在 tests/fixtures/real-model-evaluation.json 中预先固定，results 为空。',''];await writeFile('quality/验收结果.md',text.join('\n'));console.log('Mapped '+matrix.length+' baseline items.');
