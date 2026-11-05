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

## 冻结前定点完整性核验与实际本地结果

最终源码指纹：`963844f84a563f467b7adc418bb4f41dcea9fa36ba4ff0629eac3fa202052c67`。被测 git HEAD 为上述实际 base，测试的是尚未提交的本轮工作树；每条命令前后指纹一致，提交后须在全新检出验证同一源码及记录。原始日志与 Vitest JSON 保留于执行环境私有 scratch，摘要已固定在当前 construction-evidence；没有将旧版本通过冒充本版通过。

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
