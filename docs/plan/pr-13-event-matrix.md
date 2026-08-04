# PR-13 事件矩阵：钉钉待办、通知与催办

> 基线：`main@d4bb59e682fe7b38ed919719b10706596541de21`（PR #20 已合并）  
> 范围：仅 PR-13；本矩阵冻结接收人、时限、升级、深链与历史补建规则。

## 事实来源与通用规则

- `sourceAction` 只可使用下表的现有 `operation_events.action`；括号内的状态或决策是精确筛选条件，不是新的业务 action。
- 待办事实、投递尝试和钉钉回执分表保存；业务投递复用既有 `message_outbox`，不得建立第二套 outbox。
- 可操作待办按稳定用户 ID、直接有效角色、capability 及单据关系路由；禁止按姓名或向角色全员广播。`information` 通知无 due、催办或升级。
- 深链保存受白名单约束的内部 route descriptor；URL 由服务端集中构造。当前可访问页面为 `/ui/tasks/:reworkOrderId`、`/ui/process-configuration?rework=:reworkOrderId`、`/ui/wages/:periodId`；其余节点回退到返工详情。
- `general`：创建后 24h 到期、到期催办、到期后 24h 第二次催办、到期后 48h 升级、最多 2 次。`finance_return_or_wage_review`：创建后 24h 到期、到期催办、到期后 24h 升级、最多 1 次。策略值存数据库，不写死在 TypeScript。

## 第一阶段事件矩阵

| 业务节点 | sourceAction 与精确条件 | 可操作接收人 / 知会 | 去重键 | 深链 | 策略 / 升级 | 解决条件 | 补建 |
|---|---|---|---|---|---|---|---|
| 品控提交返工，进入工序配置 | `rework.submit`；after=`pending_process_configuration` | 当前直接有效 `tail_supervisor` / 无 | `process-config:{orderId}:{orderVersion}` | `process_configuration` | general / `production_management` | 后续 `rework.process_configuration.submit`；取消时取消 | 是 |
| 工序配置提交，进入 IE 审核 | `rework.process_configuration.submit`；after=`pending_ie_review` | 当前直接有效 `ie_reviewer` / 配置提交人 | `ie-review:{orderId}:{configurationVersion}` | `process_configuration` | general / `production_management` | `rework.process_configuration.review` | 是 |
| IE 驳回工序配置 | `rework.process_configuration.review`；decision=`rejected` | 当前配置负责人或直接有效 `tail_supervisor` / 原提交人 | `process-config-return:{configurationId}:{version}` | `process_configuration` | general / `production_management` | 后续再次提交或取消 | 是，仅当前未完成配置 |
| 返工进入整单审核 | `rework.work_report.submit`；after=`pending_order_review` | 当前有效整单审核处理人；默认 `tail_supervisor` / 无 | `whole-order-review:{orderId}:{orderVersion}` | `rework_detail` | general / `production_management` | `rework.whole_order.approve`；上数被驳回时取消 | 是 |
| 上数记录被整单审核驳回 | `rework.work_report.reject` | 原上数本人；临时工代录则原有效代录责任人 / 当前整单审核人 | `work-report-return:{workReportId}` | `rework_detail` | general / `production_management` | 对应补正上数提交 | 是，仅当前待补正记录 |
| 责任判定待处理 | `rework.responsibility.draft`；草稿内 `handlerUserId` 是当前处理人，后续 `rework.responsibility.transfer`/`takeover` 仅收口/替换既有待办 | 当前责任处理人；无转交时正式责任版本处理人 / `production_management` 仅查看 | `responsibility:{orderId}:{handlerVersion}` | `responsibility_detail` | general / 直接有效 `owner_group` 仅知会 | `rework.responsibility.finalize` 或合法转交替代 | 是 |
| 高倍率独立确认 | `rework.responsibility.draft`；草稿含任一 `multiplier>2` 时创建，`rework.responsibility.high_multiplier.confirm` 是完成动作 | 草稿提交人为直接 `owner_group` 时，仅另一名直接有效老板；提交人不是老板（现有主线允许 `production_management`）时，两名直接有效老板对同一确认事实并行可见，任一确认即收口 / 原判责人 | `high-multiplier:{determinationId}:{version}:{recipientId}` | `responsibility_detail` | general / 直接有效 `owner_group` 仅知会 | 独立确认 action 完成或责任版本替代 | 是 |
| 本厂承担审批 | `rework.own_factory_approval.create` | 两名直接有效 `owner_group` 成员看到同一审批事实 / 无 | `own-factory-approval:{approvalId}:{recipientId}` | `own_factory_approval` | general / 仅向仍有效的另一名老板催办 | 任一 `rework.own_factory_approval.approve` 或 reject；另一人改为 information | 是 |
| 任一老板完成本厂承担审批 | `rework.own_factory_approval.approve` | 当前其他审批待办全部完成；另一名老板仅 information | `own-factory-result:{approvalId}:{otherOwnerId}` | `own_factory_approval` | information / 无 | 已投递即完成 | 否；仅实时状态收口 |
| 外部责任业务签收 | `rework.external_responsibility.allocate`；case=`pending_business_signoff` | 正式责任类型及单据关系确定的业务经办人 / 无 | `external-signoff:{caseId}:{caseVersion}` | `external_responsibility_detail` | general / `production_management` | `rework.external_responsibility.submit` 或责任版本替代 | 是 |
| 外部责任应付确认 | `rework.external_responsibility.submit`；after=`pending_payables_confirmation` | 对应直接有效应付会计或已核验订单范围代理 / 原业务签收人 | `external-payables:{caseId}:{caseVersion}` | `external_responsibility_detail` | general / `production_management`，不授予财务动作 | accept 或 return | 是 |
| 应付退回 | `rework.external_responsibility.payables_return` | 原业务签收/处理责任人 / 退回会计 | `external-return:{caseId}:{caseVersion}` | `external_responsibility_detail` | finance_return_or_wage_review / `production_management` | 再次 submit 或责任版本替代 | 是 |
| 扣款跟进 / 扣款逾期 | `rework.external_responsibility.payables_accept`；after=`deduction_follow_up`；逾期以最新正式 `rework.external_deduction.follow_up.next_follow_up_at` 触发 | 当前有效应付跟进责任人 / 订单跟单、生产管理 | `deduction-follow-up:{caseId}:{caseVersion}`；`deduction-overdue:{caseId}:{deadline}` | `external_responsibility_detail` | 正常跟进为 general；逾期仅 `due_at=正式截止时间`，无正式字段记 `no_authoritative_deadline` 且不发逾期 | close、责任版本替代或事实不再待办 | 是，逾期仅正式截止时间已到且未关闭 |
| 工资尾部初核 | `rework.whole_order.approve`；由正式工资物化记录绑定的 source event 进入 `pending_tail_review` | 直接有效 `tail_supervisor` / 无 | `wage-tail-review:{periodId}:{periodVersion}` | `wage_period_detail` | finance_return_or_wage_review / `production_management` | `wage.tail_approve` | 是 |
| 工资行政复核 | `wage.tail_approve`；after=`pending_admin_review` | 直接有效 `administrative_clerk` / 尾部初核人 | `wage-admin-review:{periodId}:{periodVersion}` | `wage_period_detail` | finance_return_or_wage_review / 直接有效 `owner_group` 仅知会 | `wage.administrative_approve` 或 `wage.administrative_return` | 是 |
| 工资月结锁定 | `wage.administrative_approve`；after=`ready_to_lock` | 直接有效 `wage_month_close_accountant` / 行政复核人 | `wage-month-lock:{periodId}:{periodVersion}` | `wage_period_detail` | finance_return_or_wage_review / 直接有效 `owner_group` 仅知会 | `wage.month_close` | 是 |
| 工资调整申请待审批 | `wage.adjustment.request` | 直接有效 `administrative_clerk`，且不得为申请人 / 申请人 | `wage-adjustment:{adjustmentId}:{version}` | `wage_period_detail` | finance_return_or_wage_review / 直接有效 `owner_group` 仅知会 | `wage.adjustment.approve` 或 `wage.adjustment.reject` | 是 |

## 接收人失效与历史补建

接收人不再 enabled、在职、具备直接角色/capability，或失去单据关系/有效范围代理时，原待办变为 `blocked_recipient`，记录 `blocked_at` 与 `blocked_reason`；它不是完成、取消或自动转交。系统为当前直接有效的 `production_management` 创建 `recipient_routing_exception`，仅可按原业务角色、capability 和单据关系选择新接收人并记录理由。该角色不能完成老板、会计、行政、IE 或工资专属动作；`system_admin` 不获得该能力。

历史补建采用 `0026` schema + 受控幂等命令（默认 `--dry-run`，显式 `--apply --actor-user-id <direct-production-management-user-id>`）。运行先记录 `run_id`、`backfill_started_at`、`event_high_watermark`，只处理快照前仍处于表中待处理状态的记录，使用同一 dedupe key 与实时投影去重；每批独立事务保存 cursor，`--resume-run-id` 仅恢复同一 running apply run。找不到稳定业务对象、匹配 source event 或唯一接收人时，写入 backfill exception/report，不伪造业务待办或 source action。`blocked_recipient` 同时保留原待办、创建受控路由异常，并记录补建异常结果；不得自动恢复或替换接收人。
