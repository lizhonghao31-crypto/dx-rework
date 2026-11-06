# M01 P05：设置即时预览计算基础

## 施工目标与边界

依据完整施工方案 `dx-m01-implement-v1.1.1.md` §8（含 §8.6 首批真实路线矩阵）及 M01-OPT1.3。用户已授权本轮施工、正式 GitHub Codex Review 和合并，按顺序检查和合并 PR；用户后续明确允许等待 Gate 时在隔离工作树准备后续项，后续 PR 必须在前项合并后同步实际基线并复核受影响结果。P04 #905 已合并，实际远端 `release/digital-production-v1` 基线为 `7bc97df926a4a3d2b626bbbe440260d9b4104fd9`，工作分支 `m01/p05`。

本 PR 交付共享纯计算、代码拥有的路线适配、独立 strict 只读接口和技术验证。P06 交付设置页面完整交互。风险为 FULL：涉及时效计算、上下文权限与现有发布接口兼容。允许增量代码、隔离测试、Review、修复和合并；禁止部署、ECS 重启、生产或真实业务数据变更，以及操作独立 Acceptance 诊断现场。

原统一标准发布 token、开发独立标准 token、在途应用 token 与新 calculationReceipt 分离。试算不能写配置、任务、事实或业务审计，不产生通知，不授发布或应用权限。没有可信日期、事件、适用条件时保留已知分支并列缺件，不填 0 或当前时间。七个阶段的跨度可以重叠，整体从依赖图取得。

## 实现前影响记录

| 批准规则与来源 | 实际入口和读取消费者 | 初始化、历史、日期、权限 | 计划验证与预期 |
|---|---|---|---|
| §8.1–8.5、E1–E12、P05-01/02/05/07/13/14：串行、并行、内含、未知、日历与精度 | 新共享计算模块；复用 `orderedSlaNodes`、原日期边界；P06 浏览器与只读服务共同消费 | 原 `calculateSlaPlan` 调用不变；日期精度不伪造时刻；北京周日业务日历对照原 SQL helper；毫秒精度不取整 | 现有 `digital-sla-plan.test.ts` 与新增计算用例；真实 PG 日历差分；图非法明确拒绝，同长路径完整保留 |
| §8.6、P05-03/04/06/09/12：真实适用路线、独立规则及版本 | 新路线适配；现有 `developmentSlaPlan`、开发轮次/技术/外纸样、`bulkSlaEvidence`、`preparationWindow`、原生批工艺/回货/返工/装箱读取 | 冻结和现行标准分名；开发 7/5 日监督另列，双 24 按独立锚点，旧 72 保留；目标日期、物流预计、提醒不冒执行加工用时 | R1 80.5→68.5h、R2 60→48→48h、R3 168/240→156/228h；首批矩阵具名可算与缺事件分支；现有配置/开发/准备 PG 回归 |
| §8.2、P05-08/10/11：只读上下文和两个回执边界 | 新 `calculation-preview` 路由与服务；原 `task-routes.ts` strict StandardDraft、`SlaSettingsService` 与在途 apply 为旧消费者 | 认证 actor 与实时设置读权；实例再核原资源范围；绑定配置/独立规则/采用版/轮次/事实水位/scene；未知不是 unsupported；不接收任意图、客户端 actor 或完成事实 | 原真实 HTTP/PG fixture 测允许、拒绝、撤权、A→B→A、配置/锚点/事实变化、strict 额外字段和 token 不能互换；读取前后业务表不变 |

## 验证状态

开工记录：尚未执行 P05 检查，不签通过。实现后在本文件及本 PR 当前 `construction-evidence.json` 记录实际命令、来源、配置、退出码、用例数和日志摘要；再按原 light → Review → 冻结 Head → Full → 准确回执 → expected Head 合并。

协调方已核统一 v7／开发 v1 的数值与版本号作为具名演算依据；原现场快照 UUID／字节摘要尚未交付，本 PR 不把合成测试配置冒作该现场快照或已批准发布。现场独立岗位理解、M/N/B/F/EMB 原链验收、部署及性能诊断均不由本 PR 技术测试替代。

## 最终实现与消费者核对

- `packages/contracts/src/sla-calculation.ts` 定义独立 strict 请求及版本化回执；`packages/domain/src/sla-calculation.ts` 共享纯计算，`sla-calculation-routes.ts` 组装代码拥有的合法路线片段。它们没有隐式系统时钟、配置发布或业务状态写入。整体使用所选起止与依赖图；阶段可重叠，等长决定分支全部保留。未知完整范围仍保留有依据的分支。
- `/digital-production/sla-settings/calculation-preview` 沿原认证入口到 `SlaCalculationService`，使用实时设置读取权、原实例技术范围和单次 repeatable-read/read-only 快照；原 `ContextBusinessClock` 与时钟结束复核保持。上下文绑定读取者、来源、实际关联母单、选定轮次、原资料/计划/采用/独立标准/快照、PO/批范围、真实事实及 scene；来源与母单关联的变化不能套用旧回执。
- 实例读取原 `developmentTaskTiming`、`materialReadiness`、开发周期、双窗准备和 `SlaOrderService`，批工艺使用原 `factoryBatchTiming` 数量账。已回本批与待回余量分别呈现；已质检的原完成不重演为新48小时，原未放行仍给具体等待。原确有要求的合同首ready只是原发厂就绪条件，不将48业务小时回签加成生产前置。合同独立演算逐原合同保监控纳入/排除与首次有效回签依据。
- 每份最终评语绑定自己的复核任务；局部补做与合法复版沿原任务/成果关系，未知局部作业时长不借首版48小时；补做尾查使用本次原冻结窗。开发7/5日监督独立，真实外发按原区间并集扣除，进行中或失去可信时间时不给固定自然截止。外纸样完成时间被原更正为未知后，旧收到记录不能恢复有效时刻。
- 日期目标不充当完成事实；只有日期的物流保原预计到仓区间及真实厂/份额身份，不制造午夜发货或精确到仓期限。未发布物流草稿只平移原演算区间，不写回事实。原装箱数量继续就是本系统出货，不增出货操作或财务放行。
- `calculationReceipt` 只记录上下文/数值/结果摘要与计算器、日历版。调用者可用 `checkContextDigest` 要求服务重新读取比较；它没有原发布或在途应用用途。原统一与开发独立标准分别保版本、token、权限和幂等语义；原 strict StandardDraft 不接路线、锚点或计算回执。P06 在此基础上接页面即时演算与发布前重核，本 PR 不冒称已交付完整设置页面。

## 已查明并处理的问题

实现与定向复核中发现：已知串行分支只报末节点跨度、非法日期被日期库正规化、未读原生物料等待、PO字段及fixture返回字段误用、独立周期漏接真实外发扣除、外纸样更正后仍读旧收到时刻、已质检批次被重演为未来窗、相悖时间被压为0、日期物流区间未适配、合同原监控范围遗漏、来源未明确绑定母单，以及两个未使用声明。已分别修复并通过对应的真实领域/SQL/HTTP/原链用例验证；先前失败日志仍保留，不作为最终通过证据。一次新增测试直接改图锚点而未重建其事件映射，已改为正常的上下文重建反例，没有放宽计算守卫。

时间候选清单仅对本次新增服务/路由入口补显式语义注记；所有其它条目及人工注记保留。没有生成或重写其它业务索引、规则或旧迁移。新 PG 文件由现有测试计划发现与风险映射纳入；原 schema 创建/交回/精确清理协议未改。

## 本地冻结候选实际结果

本轮最终源码指纹 `934b62a310be6f0edced80c01a46932487a81b66fd5f269be30dec97d82a2d41`。实际工具链 Node 22.22.2 / npm 10.9.9；PG 16.14，低权限标记隔离库 `dx_m01_acceptance_test_dc924aaea2`、OID 694046。每个 PG 组合串行、单 worker；原技术/产前长套件沿 canonical `vitest.business-chain.config.ts`，普通 PG 沿原 `vitest.config.ts`。非 DB 单测单 worker，原 preflight 两 worker；静态工作区命令串行，与一个 PG 组合并行，未更改原时间预算。

| 检查 | 实际命令及结果 |
|---|---|
| 领域/原消费者单元 | `vitest run tests/unit/sla-calculation.test.ts tests/unit/factory-production-facts.test.ts tests/unit/digital-sla-plan.test.ts tests/unit/development-cycle.test.ts tests/unit/digital-sla-configuration.test.ts tests/unit/development-material-readiness.test.ts tests/unit/production-readiness-contract.test.ts tests/unit/development-technical-contract.test.ts --maxWorkers=1`：8 文件，132 通过，0 失败，0 跳过 |
| 普通真实 PG | `vitest run tests/integration/sla-calculation-postgres.test.ts tests/integration/digital-sla-configuration-postgres.test.ts tests/integration/digital-sla-plan-postgres.test.ts tests/integration/development-sla-enrollment-postgres.test.ts tests/integration/factory-logistics-cockpit-postgres.test.ts --maxWorkers=1`：5 文件，64 通过，0 失败，0 跳过 |
| 原生技术/产前 | `vitest run tests/integration/development-technical-postgres.test.ts tests/integration/production-readiness-postgres.test.ts --config vitest.business-chain.config.ts --maxWorkers=1`：2 文件，42 通过，0 失败，0 跳过 |
| 原预检 | `npm run test:preflight`：240 通过，0 失败，0 跳过；原静态迁移检查通过 |
| 工作区 | `npm run lint`、`npm run typecheck`、`npm run build --workspaces --if-present`、`npm run secret:scan` 均实际 exit 0；未调用根 postbuild 的业务/部署入口 |

每条提交内 construction 记录绑定此次 source、命令、起止时间、原日志 SHA256 及本次 Vitest JSON/TAP 摘要。原始结果在任务私有目录 `m01-p05-*-final6.*`；PG 身份及完成后资源核对见私有 `m01-p05-db-postcheck.json`，无残留测试 schema、无其它连接。旧 final2/final3/final4/final5 及早期失败日志保留为各自版本证据，不替代当前 final6。

收口补验已覆盖具体字段定位、原 HTTP 合法发布、相同幂等 key 的准确重试，以及旧母单冻结值不变。读取与试算本身仍由数据库 read-only 事务约束。原候选 74f6bbf 的 light 已通过；官方 Codex Review 在该 SHA 完成并提出三条 P2。以下集中修复已完成本地定向验证，最终候选仍须对应 light、实际线程闭合及最终 Full；这些待执行阶段不签通过，也不签 P06 的完整页面体验或现场业务验收。


## 官方 Review 与集中修复

正式 Review 请求 6673008424（2026-11-06T00:14:35Z），完成回执 6673013493（00:18:24Z），实际审核 SHA 为 `74f6bbf3a560ea9ae740c861db1506891cd1f878`。本段记录该审核之后的真实修复范围，不把旧审核回执声称为修复后 Head 已重审。

- [4487619579](https://github.com/lizhonghao31-crypto/dx-rework/pull/906#discussion_r4487619579)：交付起点改读 `factoryProductionCompletion` 的原生生产完成状态与业务日期；新增可选 PO 范围，原全部 PO 消费者默认行为保留。原工厂业务链真实先登记质检，断言不能打开生产完成起点，再通过原 report/complete/ship 命令验证日期精度与出货不改该日期；单元反例覆盖另一 PO 未完成不能污染所选 PO，默认全单仍未知。
- [4487619590](https://github.com/lizhonghao31-crypto/dx-rework/pull/906#discussion_r4487619590)：两独立窗口分别接 `preparationWindow` 的原开始、冻结分钟和真实完成记录；尚未建立窗口明确等待，不从当前 readiness 重开。原到仓订正事务真实使当前就绪失效，但计算中已捕获的草稿／正式窗口逐项保持原值。
- [4487619598](https://github.com/lizhonghao31-crypto/dx-rework/pull/906#discussion_r4487619598)：按当前已发布制单版与采用记录 `retainedInstructionVersion` 判断保留历史；原生历史采用反例继续列 4320 分钟旧制单和原完成时刻，不生成两新窗，原快照与窗口表不变。
- 执行者补验：全局合法的新草稿父窗口可能不兼容旧实例冻结的内含目标。共享试算返回父参数具名 `SlaCalculationInputError`，只读接口只把该草稿输入错误转为400；原拓扑与服务器错误不被吞掉。真实HTTP反例先合法发布两个60分钟内含目标并创建原生来源，再合法发布当前30分钟目标；90分钟草稿对旧来源返回具体字段400，而同一新单标准仍可沿原预览/发布合法发布，旧来源冻结不改。没有新增全局发布门槛。

补验夹具第一次在虚拟时钟内发布全局标准被原守卫正确拒绝；第二次使用固定旧版本的场景创建来源未形成所需反例。最终改为在该隔离库的普通原生业务上下文创建来源，真实冻结刚发布的标准，未修改时钟守卫或手改冻结事实。私有早期失败与定点报告保留；最终 final6 完整组合全部通过，不把单用例筛选产生的跳过计入最终覆盖。
