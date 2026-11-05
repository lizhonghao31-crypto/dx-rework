# 模块01 P02：原截止、日期精度与质量摘要

## 开工与边界

- target：`lizhonghao31-crypto/dx-rework` / `release/digital-production-v1`
- actual base：`6e41869d76cbd883954c711c00ad465fbe930a2d`（P01 #902 实际合并、fresh fetch 与 tree 核对完成）
- working branch：`m01/p02`；风险 FULL；本PR单一执行者控制Head及最终请求。
- 依据：本轮明确施工、检查、Codex Review、修复和合并授权；M01-IMPLEMENT1.1.1 v2 §5 / M01-OPT1.3 v4；根AGENTS V3.1及相关权限、SLA和显示规范。两份Library全文的取得和摘要见P01记录。
- 目标：原批次时效可追，阶段/整单日期按同一业务要求与真实精度显示，已采用计划与预计来源分开，质量/监督/做尾与返工摘要保留各自语义。
- 原SLA、期限、质检/报量/工资和业务守卫保持原权威写入；本PR只读适配和消费者。无部署、ECS、生产或Acceptance现场操作，无历史批量补时或新填报门槛。
- 顺序：当前PR完成检查修复并合并、核集成实际状态后才开始下一项。

## 影响记录（实施前）

| 批准要求 | 原写入/依据 | 本PR读取及旧消费者 | 初始化/历史边界 | 验证目标 |
|---|---|---|---|---|
| 原批次D、停表历史、双24窗口和业务时钟分源 | 原factory批次窗口、rework有效报工、preparation窗口；`SlaOrderService`原facts与evaluation | `journey-supervision` / JourneyTiming / 原详情与节点列表；原SLA API保留 | 原计划与窗口不重算、不把缺时刻补成精确时间；旧单无P0仍明示 | 不同批次D、已完/活动、原窗口/scene及物流预计反例 |
| 阶段及整体计划、实际与预计按P01同集合 | 原采用系列计划、P01要求集合、原任务时间与canonical forecast | 新日期汇总 / 总览、详情与阶段；旧字段兼容 | 部分覆盖不冒全单日，日期与时刻按可证精度；沿用成果不冒本轮采用时间 | 完整/部分/未采用、混合精度、多范围未完、预计来源及版本/时点一致 |
| QC监督、检查与合格各自说明，真实主办保留 | 原任务指派及原工厂/到仓检查记录 | Journey原生事实适配及相关展示 | 无权/缺件不写未指派或正常；结束监督不新建提醒/检查 | 主办不被聚合覆盖、停表与质量状态并存、日期排他界/瞬时等点 |
| B/F/EMB摘要按原业务类型及有效报量 | 原rework_kind、登记数量、有效原执行报数与原关联 | `OrderClosureService.read` / closure契约与原面板；原数量字段保留 | 不累计不同工序成不良总量，不用照片填数；新增明细沿原单权限 | QC返工/本厂做尾、有效报1、无有效关联和原权限正反 |

## 既有正确行为与本轮验证

日期型北京次日00:00排他界、普通瞬时等点、冻结P0、canonical forecast失效、业务时钟、无时限和物流仅预计已有实现及反例；按实际影响复用并验证，不改原判断迎合显示。

M三原D、N原现场采用时点、B/F/EMB原逐对象量/质量/工资及F原日期完整返回仍需各自原证据。技术夹具证明其声明范围，不关闭未取得的现场子项。原I源质量/结案守卫、F源归厂、通知、D23真人岗位入口等继续独立。

本次最终本地结果见下文；light、Review、最终Full、合并、部署和业务试用分别记录。

## 首次组装的定点完整性核验与本地结果（历史）

首次组装源码指纹：`963844f84a563f467b7adc418bb4f41dcea9fa36ba4ff0629eac3fa202052c67`。被测 git HEAD 为上述实际 base，测试的是尚未提交的本轮工作树；每条命令前后指纹一致，提交后须在全新检出验证同一源码及记录。原始日志与 Vitest JSON 保留于执行环境私有 scratch，摘要已固定在当前 construction-evidence；没有将旧版本通过冒充本版通过。

| 检查ID | 命令 | 实际结果 | 日志 SHA256 |
|---|---|---|---|
| m01-p02-unit-assembled | `node node_modules/vitest/vitest.mjs run tests/unit/journey-progress-dates.test.ts tests/unit/journey-business-progress.test.ts tests/unit/journey-sla-supervision.test.ts tests/unit/cockpit-home.test.ts tests/unit/cockpit-detail.test.ts tests/unit/digital-journey-cockpit.test.ts tests/unit/digital-sla-plan.test.ts tests/unit/factory-logistics-sla-projection.test.ts tests/unit/qc-progress-reminders.test.ts tests/unit/m01-time-consumers.test.ts tests/unit/digital-journey-projection.test.ts tests/unit/journey-projection-isolation.test.ts --reporter=verbose --reporter=json --outputFile=/workspace/scratch/m01-p02-unit-assembled.json` | 141 passed / 0 failed / 0 skipped | `ecb6e760a58fd49adf6ceda61791309b157f57096352e1cda19eeb51302c16e8` |
| m01-p02-permission-assembled | `node node_modules/vitest/vitest.mjs run tests/unit/rework-business-detail-attachment-authorization.test.ts --reporter=verbose --reporter=json --outputFile=/workspace/scratch/m01-p02-permission-assembled.json` | 4 passed / 0 failed / 0 skipped | `e254fedefb313dbb936fdf71a8832e68a460582eba4ad4af378a3b72e0b3867b` |
| m01-p02-pg-assembled | `node node_modules/vitest/vitest.mjs run tests/integration/sourcing-pr03-postgres.test.ts tests/integration/business-anchors-clock-postgres.test.ts tests/integration/optional-tail-inspection-postgres.test.ts tests/integration/digital-journey-postgres.test.ts -t "SLA06 dispatches released&#124;SLA07 records factory&#124;P13/P14 whole-order&#124;P14 reads empty&#124;native business occurrence anchors&#124;optional tail inspection&#124;V2 Journey" --reporter=verbose --reporter=json --outputFile=/workspace/scratch/m01-p02-pg-assembled.json` | 63 passed / 0 failed / 137 skipped | `b0bff2c1bf118403853a96f42f9f6ebeb708ae1df4c84edaa264afbc76a97c41` |
| m01-p02-types-assembled | `npm run typecheck` | exit 0 | `2df9af99fe74bad919c36bc1d9e2bc160fcb48526566b4a9ff74653fec0dd74e` |
| m01-p02-lint-assembled | `npm run lint` | exit 0 | `fe68a45f894b97fe42ab32bd073231806b176f891729cd5a5a0715707246e763` |
| m01-p02-build-assembled | `npm run build --workspaces --if-present` | exit 0 | `1ca44cd1a03cd4d0afee7ea55c38cc7ced3acffc6eca9b057795c5c78fbae95c` |
| m01-p02-secret-assembled | `npm run secret:scan` | exit 0 | `e41648ae52b20dec12f1a629ecc0096df7be90f1c557e46cfa97dfbb12429bda` |
| m01-p02-browser-assembled | `node /workspace/scratch/m01-p02-ui/browser.mjs` | exit 0 | `a5aa1e34f427c840705aa47816c64211f056b107b39ac037e2ee2ee7872bfc94` |

数据库回归使用本地 PostgreSQL16.14、标记测试库 `dx_m01_acceptance_test_dc924aaea2`（OID694046）、`dx_rework_test` 低权限角色和原 schema 创建/清理入口。PG63通过、137按显式名称过滤跳过，不把这些未执行用例列为通过。完整 Journey、原生业务时钟和 optional-tail 套件及选定SLA06/SLA07/P13/P14链路已执行；完整最终Full仍独立等待。

浏览器采用该次隔离数据库原主跟单读取的真实夹具，输入SHA256 `98a0b15707b65e49c2d79728e4373944f38709f78fc69aec0cebfacdfc8ebfbc`，Chromium151.0.7922.173；1440/390两宽通过、无页面或各阶段日期溢出、仅GET。截图在私有 `m01-p02-ui/evidence`。无对应夹具的资料目录请求明确显示读取失败，故此证据只覆盖新增时间/QC消费者布局与只读，不证明资料目录或真实岗位现场已通过。

定点复核已查原写入、调用与旧消费者：原任务D不被canonical汇总覆盖；原生检查完成不清除指派/暂停；原完成、各厂完成日、监督终态、合格结果分别取原件；日期型排他界与瞬时D仍沿原规则；新日期聚合不以部分PO、旧成果或时效计划枚举冒完整采用；结案摘要沿原完整业务详情权限，且从原结案revision排除新增的展示字段。原工资/质量/结案守卫和实际写入口均未调整。

前期失败保留：初次原生时钟夹具被测试库命名守卫拒绝，改用新建且有安全标记的低权限本地测试库，未放宽守卫；批次用例改为实际座舱compact读取。扩大旧回归暴露三类兼容问题后集中修复：日期说明新增待核标注对应旧UI断言；最小unit夹具补齐原必有lines；时效与新日期评价统一读取原trusted观察时点，而原SQL快照、既有未来日期观察和已安装clock-reader语义保留。结案读取权限对照保留无明细字段，原实绩跨岗位比较仅剔除权限敏感显示字段，Root原件和拒绝用例分别验证。最终通过来自上表新命令，不引用这些失败或旧草稿结果放行。

M三原D、N采用时点及B/F/EMB原件仍须逐对象受控试用。技术反例和隔离库链路不关闭原I质量/收口守卫、F归厂、最终核量/工资、通知或真人赋权。未部署、未操作生产或现有Acceptance现场。

## Light 记录清单修复

首个候选 cea65ed1 的 light run42092631108 / job127474377558 在 protocol_tests 失败：时间来源候选发生改变，但原清单未同步。变更证据校验已通过，后续安装、lint、types、build未执行，不能据此称light通过；没有开启Review或最终Full。

按原 `scripts/acceptance/time-site-inventory.mjs --write` 更新的实际差异仅 journey-query 与 journey-supervision 两项。审阅本次出现/消费者链后补其语义说明，保留旧有效业务、诊断注记及所有其他条目，不扩大忽略、不改脚本或检查标准。原 `npm run test:preflight` 新执行240/240通过、0失败、0跳过；日志SHA256 `e5d6996c76b76015827d5e5ee8fecae5c167fcca28e8b03f3c5a6b1ef93c9ba6`，详见当前记录第9项。源码指纹仍为963844f84a563f467b7adc418bb4f41dcea9fa36ba4ff0629eac3fa202052c67，本次仅文档和证据修复，未重复业务PG。

## 测试资源闭环修复与当前结果

当前源码指纹：`d543a1ecd64f444c85d9aa12ea7731578a867416faed9c406159df5915715f06`。实际base保持不变，应用代码与首次组装一致，只有被扩充的 optional-tail 集成夹具迁入原资源登记/释放API（两个schema入口）。这是对现行资源规则的补齐，不放宽注册检查。

先前的协议预检是在HEAD工作树运行；追加显式 `BASE_SHA=6e41869d76cbd883954c711c00ad465fbe930a2d` 的适用预检发现该旧夹具直接创建schema。修复后原预检240/240通过，实际原生protocol worker为2；Vitest PG worker为1。以准确base检查的失败不记通过，旧light通过也不批准修复后的Head。

未受影响的unit141、附件权限4、type/build和浏览器结果按仓库支持的明确inputPaths复用：2026-11-05T19:24:24.257Z捕获时完整原963844f8源码仍匹配原成功执行，输入摘要 `b0de7144fe1df2aebfb7cc358bbc6714bbcc9eac2e4eee10c06d9736cc860984`；最终这些输入逐字未变。旧命令、来源指纹、原始日志均保留，未改称为新Head执行。数据库组合、历史图片SQL范围、lint、secrets及适用base预检均重新执行。

| 当前检查ID | 实际结果 | 原始日志SHA256 |
|---|---|---|
| m01-p02-unit-assembled | 141 passed / 0 failed / 0 skipped（明确未变输入复用） | `ecb6e760a58fd49adf6ceda61791309b157f57096352e1cda19eeb51302c16e8` |
| m01-p02-permission-assembled | 4 passed / 0 failed / 0 skipped（明确未变输入复用） | `e254fedefb313dbb936fdf71a8832e68a460582eba4ad4af378a3b72e0b3867b` |
| m01-p02-types-assembled | exit 0（明确未变输入复用） | `2df9af99fe74bad919c36bc1d9e2bc160fcb48526566b4a9ff74653fec0dd74e` |
| m01-p02-build-assembled | exit 0（明确未变输入复用） | `1ca44cd1a03cd4d0afee7ea55c38cc7ced3acffc6eca9b057795c5c78fbae95c` |
| m01-p02-browser-assembled | exit 0（明确未变输入复用） | `a5aa1e34f427c840705aa47816c64211f056b107b39ac037e2ee2ee7872bfc94` |
| m01-p02-pg-resourcefix | 63 passed / 0 failed / 137 skipped | `0bff94fa7bfab1a0b4b11b3d2038c21f93023bff62492997a6194170b73088be` |
| m01-p02-history-resourcefix | 4 passed / 0 failed / 2 skipped | `72dde5323bc494c10f871ef22ea63964310a28400c9991ec681e308ad84fc13a` |
| m01-p02-preflight-resourcefix | 240 passed / 0 failed / 0 skipped | `d8de618c4f588826f9663055983aacd037eb006dc198c8195a1cfe304e0c396f` |
| m01-p02-lint-resourcefix | exit 0 | `fe68a45f894b97fe42ab32bd073231806b176f891729cd5a5a0715707246e763` |
| m01-p02-secret-resourcefix | exit 0 | `e41648ae52b20dec12f1a629ecc0096df7be90f1c557e46cfa97dfbb12429bda` |

PG组合63通过与历史SQL范围4通过为各自真实命令结果，按名称过滤的skip分别保留，不将skip累加成未经验证的唯一用例数量。原完整current construction记录4条规则、10项检查给出具体命令、起止时点、来源、日志和报告摘要；本段不代替最终light、独立Review、Full与合并。

## 官方 Review 集中修复后的当前候选

官方 Codex Review 完成于已推送的93d8aaed，明确发现两条P2，均成立：

- [4485154574](https://github.com/lizhonghao31-crypto/dx-rework/pull/903#discussion_r4485154574)：工序摘要原取actual_quantity，漏掉原生有效数量修订。现改用 `rework_work_report_effective_quantity`，生效任务、approved工序和未驳回过滤不变。真实链测试原5不改，原生修订3再4、同key重试、原单有效总量一致、驳回另1后有效量4；没有调整原核量/工资写入。
- [4485154584](https://github.com/lizhonghao31-crypto/dx-rework/pull/903#discussion_r4485154584)：原任务中真实date_target不等于瞬时D。Journey现在沿原完整/summary任务DTO传递deadlineMode/deadlineExclusive及date精度；首页、节点表、详情统一使用原北京日终显示，真实duration继续保时刻。真实船样任务完整/compact读取与UI反例分别验证。

另补明确旧72h/实际24h窗口保留和两个独立2h待办D−1ms/D/D+1ms消费者反例，不改原领域守卫。最初2h夹具把尚未发生的后继起点带入更早观察，被原领域guard拒绝；只修夹具按观察可见事实构造，未放宽future-event守卫。新增date_target候选按原时间来源生成器核3项，原业务、node-material与诊断注记保留。

当前应用/测试全量来源指纹：`9a4c6fbba7ce505465351955d9efaf51dbfbdca456d70ed21d31851ae8d001be`。下表全部重新执行于同一最终工作树，前后未变；本版不以旧963/d543的通过替代当前修复检查。Review SHA与后续修复提交须分别记录，不冒称修复提交已独立重审。

| 当前检查ID | 实际结果 | 日志SHA256 |
|---|---|---|
| m01-p02-unit-finalfix | 147 passed / 0 failed / 0 skipped | `56a6eefe703f53b3a2fe20e88d728082c972b400a212db108e12c5454127b7ce` |
| m01-p02-pg-finalfix | 67 passed / 0 failed / 133 skipped | `3f6c440948d8915c68738bbc913f19f951a1727b413482e5709ab78ea184c5af` |
| m01-p02-preflight-finalfix | 240 passed / 0 failed / 0 skipped | `79fa801c88e2142fa964fc789de08485a50e068a4c15d54f886a9b39ddb60726` |
| m01-p02-types-finalfix | exit 0 | `2df9af99fe74bad919c36bc1d9e2bc160fcb48526566b4a9ff74653fec0dd74e` |
| m01-p02-lint-finalfix | exit 0 | `fe68a45f894b97fe42ab32bd073231806b176f891729cd5a5a0715707246e763` |
| m01-p02-build-finalfix | exit 0 | `7862e33c0f1c37e65ffa402d91ea2fbeca4c9a541ae93cf7cf292b3be9b766b7` |
| m01-p02-secret-finalfix | exit 0 | `e41648ae52b20dec12f1a629ecc0096df7be90f1c557e46cfa97dfbb12429bda` |
| m01-p02-browser-finalfix2 | exit 0 | `7828f321262987421baff3038dc2040439ed9d8e0ab10a696da39e70418e1279` |

修复版原生主跟单浏览器输入SHA256 `af4c7d7b0cefe057be9021d9cdd253e5e9719d39173fc68e1f4f360d590cd89a`，1440/390均验证原日期型任务行“当天结束”及无body/阶段列溢出。该样本真实船样任务属于原历史行；不把它强改当前，不以这个浏览器样本声称真实首页当前任务状态归属已验。原记录不变，当前/历史归属问题与未取得的现场原件另保留边界。第一次浏览器断言错误地选择current占位行，改为选择原date_target任务，未修改业务帧或应用状态。原93d8输入/截图保留，修复版证据写入独立ui-finalfix目录。

本地数据库在修复重验后再次核实：专属标记/OID/低权限身份相符、只剩public、其他客户连接0。当前原始日志及结果报告与construction各check摘要一致。最终新Head仍须light、解决两条真实Review线程、原外置包preview/apply、Full与准确回执后方可合并；没有部署或改现有Acceptance现场。

## 首次最终 Full 的失败与测试夹具补齐

258fe20b 的 exact light42098318894/job127494132181 成功，原控制器核收口包后唯一创建最终请求，Full42099151677/attempt1。非数据库job127497900664于2026-11-05T20:09Z失败：3274 passed、7 failed、11 skipped；7项均在旧 `digital-pmc-readonly-access` 中，严格模拟数据库未提供新增 `readClosureWorkSummary` 的 SELECT。不能把该运行或旧版本通过记成新候选通过。原解码日志保留 `/workspace/scratch/m01-p02-258-full-non-db.log`。

本次只补该权限夹具的原业务类型、原生有效报量查询和明确结果断言，不改任何应用代码、权限、数量函数或原写入断言；未将未知SQL统一放行。该40项测试全部通过，保留PMC纯只读、复合角色/撤权、403及无写入断言。另重新执行原定向147项、准确base预检240项、types、lint、secret扫描，全部通过。一次错误的秘密扫描路径未存在而失败，保留失败日志；随后按原 `npm run secret:scan` 成功，未当作同一次成功或删去失败。

当前源码指纹 `73a88f0ec0fe280f0eff59be4cfd56e95cde724004e07f169a522b8f7db7a260`。PG67/133名称过滤、build与浏览器2尺寸沿仓库支持的明确输入复用：在完整9a4c6f源码仍匹配原执行时先捕获app/domain/集成测试/helper/browser/config输入，补夹具后逐字相同；旧命令、来源指纹、报告与日志未重标成新执行。187项本地单测与240预检为当前实际执行，原始摘要见当前construction的4条规则9项检查。不得跨Head复用GitHub最终Full；新Head仍须新light、当前收口包及自身最终Full。官方Review实际覆盖93d8aaed，两个已修P2的线程已关闭，本次仅测试夹具补齐，不冒称新Head已独立重审。
