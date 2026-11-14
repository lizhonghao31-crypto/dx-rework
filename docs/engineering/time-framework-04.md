# 时间专项 PR04：特殊工艺完整闭环

已批准依据：第27版 §9.1–9.2.1、原8PR表第04项，以及2026-11-13用户明确授权连续施工、逐项合并集中验收。工作分支 feat/time-framework-04，目标 release/digital-production-v1，实际基线07dff9b8ab2b66f75c6696dc837480c33f48412b（#979）。风险 FULL。禁止部署和现场数据操作。

交付：同一管理设置里的特殊工艺库，开发/大货各自用时日历提醒；原工艺选择及排序；稳定独立步骤、实际印花师傅指派与窄行报价；原任务、发收检查及通知；预算费用引用和历史保护。未完整依赖启用前不向新订单开放半套路线。正常大货洗水属于PR05，不混入。

影响记录（实现前）：
- 工艺库标准写入→选项读取→本单冻结：维护沿时效管理权限，改名/停用/时效改版不得覆盖历史。实际选用才校验适用阶段配置。
- 工艺步骤选择→开发/大货路线→原生任务及发收检查：现有craftKind只允许印绣、数据库UNIQUE(route_ref,craft_kind)、委派按kind，须一起改为稳定步骤识别，防多项特殊工艺被合并。
- 对应步骤实际指派→报价行→客户确认→预算/合同引用：继承#979分项独立规则，开发/大货依据分离；不把特殊工艺费自动塞入成衣厂单价，不放宽原价格权限。
- 设置快照/本单采用/未来变更消费者：PR04提供完整新增字段及读写兼容；06集中接统一采用和设置汇总。旧订单原格式继续读取，不全量改写。
- 测试：库版本与停用、重复步骤拒绝、多特殊工艺与印绣串行、阶段时长独立、窄行授权/撤权、报价预算历史、实际发收及下一节点、旧双工艺回归。无现场验收声明。

当前：工艺库迁移、版本管理服务、原设置权限及管理面板已在本地实现；尚未提交或创建PR、未启用新订单路线、未部署。多步骤身份、原任务／报价／发收接线继续施工，不能视为完整交付。

已完成定向验证（2026-11-13，Node22.22.0，PG16.14，隔离低权限测试库 dx_rework_acceptance_test_r5）：
- npm run build:packages，退出0；新工作区第一次直接执行vitest因未构建内部包导致0用例，完成正常构建后才执行以下测试，不计先前尝试通过。
- vitest.business-chain.config.ts，special-craft-library-postgres.test.ts，4通过0失败0跳过，退出0，日志 /tmp/time-framework-04-library-pg.log。测试覆盖阶段独立与缺值、历史改名停用保护、幂等并发、PMC只读和真实角色撤权；不是业务完整链或现场验收。
- npm run typecheck 全工作区退出0；导航保护参数修正后 web typecheck退出0。日志 /tmp/time-framework-04-types.log、/tmp/time-framework-04-web-types.log。
- 新增库服务、合同、UI及库测试定向eslint退出0，日志 /tmp/time-framework-04-lint.log。

待继续：稳定步骤身份及重复kind消费者、实际指派和行级报价、开发／大货发收QC、历史兼容、新库界面真实交互和全链回归。未启动CI。


2026-11-13 后续施工实际进度（未提交、未开PR）：
- 多特殊工艺稳定步骤与开发总委派、原发出/加工/回样确认、报价窄行权限已接通。大货串行批次发收/QC、最后工艺通过才发厂已接通，按冻结开发/大货各自用时与提醒计算。
- 原任务通知显示具体冻结工艺名称；报价行保留库版本和步骤引用。原客户确认→正式单→预算链算例30+10+3+4=47通过，成衣厂合同单价未自动填入工艺费；库改名停用不改确认报价和预算。
- 正式制单继承本单已发布开发来源的冻结工艺；初次发布不因库后来停用而拒绝。新增选择仍受启用和当前版本校验。混合多工艺不再以步骤数量误判原印绣双工艺标准；两个演算路径临时步骤ID均按稳定工艺身份区分。
- 原App1165px完成库配置保存、切页保留、多个特殊工艺与印花选择/排序/保存；实际查看截图后修正工艺列表挤在一列的问题，复用原按钮样式。650px原移动导航遮挡问题未宣称通过，未修改全局导航。
- 最新单元及risk-map 4文件100项通过（/tmp/time-framework-04-route-audit-unit.log）；原生PG2项通过，覆盖通知/窄权限/报价预算/停用后继承制单/批次发收检查（/tmp/time-framework-04-inheritance-pg.log）；原App浏览器2项通过（/tmp/time-framework-04-browser-layout-pg.log）。完整typecheck退出0（/tmp/time-framework-04-types-route-audit.log）；全改动eslint曾通过（/tmp/time-framework-04-lint-complete.log），其后新增浏览器用例与局部CSS仍需最终复核。此前故障为新增测试误用fixture账号别名及漏填预缩，已按真实fixture和原业务必填修正，未放宽业务校验。
- 尚未收口：大货阶段单独新增特殊工艺的实际人员/报价依据，以及阶段费用独立读取和完整消费者审查。现有开发报价转预算证据不能冒称这些已完成；新选择默认不开启。完成后再冻结提交、Review和Full，不推已知不完整候选试CI。

2026-11-13 大货新增工艺收口（本地候选）：
- 大货发布读取本次制单对应步骤，独立报价行由原报价协作指派实际印花师傅；开发报价留历史，不自动复制大货价格。行级授权、站内通知/待办、报价完成后关闭待办已接通；发收页只读取负责人姓名，不泄露价格。
- 原生隔离测试覆盖开发两工艺及大货单独新增第三工艺，开发30+10+3+4=47、大货30+10+7+9+11=67；客户确认70后明确采用/细化预算成为67，原确认历史47不变；成衣厂单价仍空。
- 真实App通过大货新增工艺指派、师傅填价以及同一登录会话撤权后的拒绝。实际查看1165px截图；沿原界面横向表格，新增阶段/版本与历史工艺信息。新选择仍关闭，未部署、未修改现场数据。
- 当前源码定向结果：PG16共59项、PG13库/版本/权限5项、浏览器3项、单元及兼容123项均通过；完整typecheck及lint退出0。日志与结构化结果位于 /tmp/time-framework-04-{pg-final,pg13-final,browser-final,units-final}.{log,json}。先前总non-db发现旧mock缺craftSteps及迁移权限清单遗漏，已集中修正并在123项中验证；首轮总non-db已结束：3928通过、3失败、15跳过；失败仅上述两类，共3项，修复后对应22项权限及18项迁移兼容已全部通过（含在123项内），不因这三项重跑整个non-db。
- 已核当前远端目标仍为07dff9b8ab2b66f75c6696dc837480c33f48412b。历史manual报价不被转换；新采用链整体启用及正式回退SHA读取验证仍属06/08。正常大货洗水仍属05。此记录不构成现场Acceptance验收。

## Review 4570033438 — built-in printing quote identity

The shared task kind selected the latest special-craft worker for built-in printing. Quotation assembly now uses task-position/step identities to exclude special work from the built-in recipient and shares that scoped lookup with special quote recipients. Cancelled task access is not used. Legacy routes without special steps retain the original schema path. The arrangement reader already distinguishes special step references; no global role changes were required.

Regression: built-in printing followed by two special crafts, different craftsmen, original price retained, wrong-row writes rejected; the original App also verifies retained printing read/write permission in the same authenticated session after another artisan starts special work. A helper's old assumption that any two craft choices imply the built-in dual SLA was corrected to apply only to the two built-in choices. Isolated role setup uses the existing audited assignment service and reassignment uses the original total-arrangement command.

Current repaired working-tree results: PG16/native/browser/legacy combinations 64 passed, PG13 8 passed, unit/mapping/compatibility 123 passed; focused ESLint and API typecheck passed. Initial new fixture attempts failed on missing trusted role context, direct reassignment outside total arrangement, and the mixed-two-step helper expectation; all were corrected without weakening business guards. Exact logs/reports are recorded in construction-evidence.json. Prior full non-db run is not relabelled successful. No deployment or onsite data changes; follow-up Review was not requested.

## Full43534392655 — PMC keyboard tab expectation

The only failing long-PG assertion assumed End selected the old last customer tab. Special crafts are now the fourth/final tab, so the selected value was correctly false for customers. No production permission or keyboard behavior was changed. The original R5 browser suite now verifies End focuses/selects special crafts, PMC's craft fields are disabled, add/save controls absent, direct POST returns403 and creates no new version; ArrowLeft selects customers and executes the existing forbidden-write assertions, then Home returns to read-only standards. Entire R5 suite:7 passed, focused ESLint passed. Other keyboard selectors were searched; legacy three-tab assertions target the separate old panel, not this workspace.

The failed Full remains failed (common preparation/non-db passed; PG199/199,60/60 then553/554). Prior local64/8/123 results are retained only after validating the exact prior source checkout and byte-identical inputs excluding this independent changed test. Current head needs its own Light/Full; no report-only business reruns or deployment.

## Release advancement after final Full success

Full43540312205 passed on aa5a0b7b against07dff9b8. Release then advanced to ea857753f847004c9419a3bbd0610085dccb6c91 (#978 capacity lifecycle fix). A three-way merge found exactly one conflict, the shared current construction-evidence.json; no application/contract/business-test conflicts. Both code sets are preserved and this PR's current evidence is rebound to the actual new base.

Combined candidate verification:128 unit/mapping/compatibility/capacity tests passed (capacity includes its27 Python boundary cases). Retained PG/native/browser results have exact prior source and tracked input equivalence checked; changed deployment-only files are not inputs to those business suites. This is not a claim that the prior Full certified the new tuple. New candidate Light/Full remains required for default automatic merge. PR05–08 preserved, not continued; PR04 Acceptance must pass before PR05 resumes. No server operations.
