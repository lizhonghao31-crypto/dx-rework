# P10 原待办、座舱与统计统一监督

## 基线、范围与独立交付

- repository: lizhonghao31-crypto/dx-rework
- base: release/digital-production-v1 @ 9b0a899f748870807fe7c4277568ea30f581dd7f
- branch: feat/sla-10-supervision-20261026；FULL，先交draft，不Review、不合并、不部署。
- P09 为独立 PR859 @ b9763a2f4d0d9da3cf554fc40400af264b42774b，Full40315895701成功。其按分类跳过步骤不是通过。P09验证记录见该PR的 docs/engineering/sla-p09-p10-20261026.md。
- 原WIP0ee7bd457a813be8a3fd1ceb859437f0ce616c4b保留，不整支合入。P10沿现有Journey读取/页面增量，没有另一套异常、待办、数量或SLA事实台账。
- 当前Acceptance仍9b0a899；空scenario、寄样ready误挡材料补正、pattern_assignment_ready墙钟污染三项由主聊天另行修，不夹带。

## 实现落点

1. JourneyQuery只在原座舱scope/compact读路径接入 canonical SlaOrderService/developmentSlaEvidence，沿同一个只读数据库快照。原工作台/R2路径不强制执行全母单SLA读。单任务授权不扩展为全部PO/首版计划权限；完整投影还核现役角色与原关联人。历史轮次保留旧时间，折叠区明确为“当前有效时效”。
2. journey-supervision是只读适配：原任务/批次事实 → 原求值器 → 节点目标、实际、滚动预计及P0/Pk。未知、前置冲突和过期预计保留原原因；物流仅预计。多PO只合并风险，不将某个PO目标冒充整个聚合任务目标。外包裁床保留原计时，不套内部真实C24h。
3. 客户整单交期KPI与在办节点局部风险分开，整单提前提醒取本单冻结/显式应用后的同一 order_shipping_reminder 目标。缺客户日、工厂日、预计到布日、可信C、历史首版计划或整单读取权限均说清影响；只排除相关统计，已有局部逾期仍计。已结束节点的旧逾期保留历史，不进入“在办局部逾期”。点击缺项只过滤原有授权订单列表，原权限/入口继续有效。
4. Todo DTO增加可选只读timing。原数字任务用原deadline revision；原商务待办用原创建事件快照与原截止，并共用P09的应用引用SQL。成衣质检用原批次窗口，工厂补检用原当前计划/PO目标。没有可信开始不以todo.createdAt造开始，没有独立窗口不强造限时。场景业务时间用于状态与停留时长；已读不完成、不改原reminder_count、due_at、任务状态或读回执。日期型截止显示北京时间当天结束，时分型在等号时按原精度评价。
5. UI沿原组件/token/布局，只补统计数字旁小提示、当前节点主要目标或预计、原待办状态。多类日期、原因和版本折叠；移除空“时间待完善”条形，不用流逝时间冒充业务完成率。原七阶段各1/7、适用业务节点等权，收齐不代表全部100%。原分析沙盘/事实及设置授权保持，不引入自动放宽标准。

## 与P09接续

P10独立以9b0a899为base，避免对同一累计差异重复Full；现工作流不接受任意feature作为base，不修改白名单。P09/P10共享的极小只读基础是同一路径 sla-sourcing-deadline-sql.ts（逐字相同）以及 SlaOrderService.readWithClient 结构。后者两PR在返回字段/同一行上有合并交界：组合时保留P09的facts/evaluationPlan/applications与窗口应用、P10消费evaluationPlan的只读接线；notification-service同一SELECT行保留双方entered_at/sla_basis/既有去重字段，使用to_jsonb兼容旧列。还有TodoService和Sourcing测试首行的双方新增import交界；均只并存双方导入，不整文件覆盖或遗漏一方。其余TodoService上下文SQL（P09）与响应展示（P10）都保留。

已在独立本地worktree组合P09/P10并处理上述4处文本交界，API/Web类型通过；16项原生PG定向用例通过、150显式筛选skip。另断言显式应用后Journey预缩/IE目标等于原任务/待办目标，P0与当前版本正确、临期点仍来自冻结比例。组合tree 1d8f080d4ee7dd9462631b9a61348130e70ddada 为本地证明，不是远端分支或已合并版本；复现patch/JSON保存在本任务evidence。P10独立Gate仍只证明自身base增量，不能替代最终整批/Acceptance验收。合并、额外Review与Acceptance部署不在本轮授权内。任何组合冲突先明确核对，不把任一旧Head绿灯移用。

## 本地验证与真实限制

Node22，隔离PostgreSQL16.2，独立owned schema。没有真实订单、真实员工通知、ECS/线上数据库操作。

- 类型检查：API/Web；实际修改文件限定lint；API/Web build、secret-scan、git diff --check。Web已有大chunk提示保留，不扩成打包重构。
- 单元初跑2494 passed/2 failed，两项仍期待已移除的“时间规则待完善”占位文案；更新直接断言后有关显示/投影/待办套件通过，旧权限/进度反例保留。新增：未知不抹局部风险、P0与工时独立、日期日终/时分等号、完成时间未知不回退业务、物流非硬期限、外包计时、多PO聚合、历史逾期不冒充在办。
- 原生Journey初跑24/25，新增测试写错旧表名导致1fail，纠正后新增组通过；最终完整26/26通过；完整运行还捕获新增用例复用前一用例已撤权人员的问题，改用独立TEST身份并走原角色授予服务，未撤销原负例或放松守卫。
- 最终受影响原生Journey/Sourcing组10 passed、150按筛选skip（不是160全过）：真实权限与撤权、来源/母单、商务原始截止及模拟场景时间、工厂转厂补检、成衣批次/收齐更正、原质量/数量守卫。原Sourcing完整134项本地未全重跑，最终Gate适用长链另核。
- 原Acceptance时钟14 passed/1显式skip；跳过的是其原live-browser。本P10浏览器不是该场景或现场Acceptance的替代。
- 新工作树首次运行缺共享包dist，测试未进入；补构建后才运行。新商务用例首次变量重名/一次CLI重复-t未执行成功，局部纠正后上面的实际PG用例通过，不记作业务失败或环境随机问题。
- 浏览器使用实际App及原页面，合成HTTP，1440/390：缺项筛选/清除、低密度和长值、原只读链接、折叠、刷新失败保留事实、已读仍逾期、同一时钟停留。窄屏沿原CSS折叠停留列，桌面显示；未改原移动布局。原生API/PG验证另列，不冒称真实浏览器端到端。
- 浏览器夹具缺notification claim的actor header曾触发既有安全刷新，补正确夹具header；截图曾落在150ms列表重新读取期间，改为等待新读取与aria-busy=false后采集，不改变生产逻辑。截图见 evidence/sla-p10-20261026。

旧 digital-my-todo-context-postgres 有3项在未修改7ec4213（相关代码/夹具与9b0a899相同）复现，7pass/3fail：
1. searches the actual primary merchandiser order style and keeps node title separate：旧夹具期待只一项，实际已有另一原待办。
2. does not invent a style when the exact resource identity is unavailable：旧标题期待“开发核配委派”，现原标题“文员核配委派”。
3. identifies routing exceptions only for authorized readers without granting execution and keeps stale identities out：同一标题旧断言。
这些不是本轮已通过，也没有靠修改原断言求绿。新时钟/待办只读回归归属Journey完整schema套件；此旧文件原样保留，基线与本轮日志存本地evidence。原先todo-notification-foundation三项既有夹具缺口也不计通过、不扩治理。

## 远端Gate与成本

真实分类：businessChainSensitive/dbRequired/journeyPg13Compat=true，migrationSensitive/deploymentSensitive=false。映射Journey与Sourcing；初始化/Head迁移、普通测试、业务长链及Journey PG13按现行工作流适用步骤执行。没有新migration/manifest/checksum、workflow/阈值/timeout/依赖锁修改。30分钟仅是Full上限，runner实际耗时未知；不另跑本地整套Full再重复远端，不重复触发Review。新Head的Gate与本地定向、后续审查、现场验收各自独立取证。

## 2026-10-26 Codex Review 两项闭环

审查对象为9e4492bc6508600809c95522b7b978524f759c16，receipt5652918519，13:44:48 UTC完成。父线程已获用户批准统一安排四PR审查与组合回归；本PR不再请求Review，也不自行合并或部署。

- r4377890596：独立P10缺少原商务责任窗口/原生transition事实适配，因此个人待办已有IE逾期或审批完成，座舱仍显示未开始。此前组合验证因P09已带同一适配器而未发现独立交付缺口。现逐字复用P09 sourcing-sla-evidence.ts并接入SlaOrderService.readWithClient；读取原待办截止、原创建事件冻结快照和实际审批事件，显式应用仍共用原SQL，不新增可编辑事实来源。
- r4377890607：将seconds=null等同无独立时限，混淆了尚无开放批次窗口。现仅在捕获的parameterKey对应固定unlimited参数类型且seconds为空时显示无独立时限；缺批次窗口、未知参数及缺依据均保持未知，不从当前全局数值补历史。未改变原时限、权限、批次或完成条件。

本轮实际验证：

- 相关单元38项通过，覆盖unknown/unlimited类型、原通知上下文和商务待办；没有删除原负例。
- 隔离PG16.2完整Sourcing134、Journey26、Acceptance时钟14项通过，共174通过、1原live-browser明确跳过。新增原生商务逾期/全部三段审批完成与原待办目标一致、无批次窗口未知→真实回仓后有窗口的断言。跨角色/场景和历史更正沿完整原套件验证；不代表现场Acceptance已验收。
- 实际App路由/原组件，合成HTTP，1440和390两尺寸通过：未知批次显示“时效未定”，不显示“无独立时限”，无横向溢出；原筛选、折叠、只读链接、刷新失败保留事实及未读/完成区分仍通过。新截图unknown-batch-390.png在本任务证据目录；原生数据链由上述PG另证。
- API/Web类型、所有实际修改代码/测试限定lint、API build、secret-scan和diff whitespace检查通过。无新依赖、migration、workflow或真实数据操作。

上述旧Head Full40325843349成功不能移用为修复后Head通过；修复稳定提交后由同一PR自然触发新Head Full。旧组合tree1d8f080d不再代表最终四PR组合，父线程需按新Head重建。原Review不是修后独立二审。旧夹具缺口保持不变，不计通过。
