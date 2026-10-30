# 临时特殊工序代报生产热修

## 基线和范围

- repository：`lizhonghao31-crypto/dx-rework`
- base branch：`main`
- base SHA：`67841e105fe7090e219477171d3cf79565719241`
- working branch：`fix/temporary-special-proxy-report-20261030`
- gate class：`FULL`
- task scope：修复授权人员为已分配临时人员登记整查及其他工艺数量时，服务允许但数据库拒绝的问题。
- allowed files：新增迁移 `0231_temporary_special_process_proxy_reporting.sql`、migration manifest、对应 main maintenance plan 及其准入回归、本次 PostgreSQL 回归和本文。
- forbidden files：历史迁移、release 的 SLA 及数字生产代码、现场人员／角色／任务／报数／工资数据。

2026-10-30 核验远端 main 与正式站公开版本均为上述 SHA，正式 schema 与 expected schema 均为 `0230_sourcing_factory_change_current_quantity`。当前施工只准备代码和隔离验证；不执行生产迁移或业务报数。

## 触发和修复行为

普通返工工序与特殊工序可以一起报数。合法非 Root 代报者在服务中使用 `work:report_for_worker`；0166 的数据库插入守卫却只允许 `tail_inspection:report` 写特殊工序，导致整批事务失败。`other_craft` 复用 `tail_inspection` 执行类型是现有业务设计，不应修改现场任务类型绕过。

新增迁移替换报数插入守卫，增加当前权限判断函数：

- 任务必须 active、订单必须 in_progress，报数中的任务、订单、配置项相互对应。
- 原审计上下文的 event、request、action、entity 与报数仍匹配，审计 actor 必须与 submitted_by 一致。
- 当前模块写策略、账号启用、有效组织身份和实际权限重新校验。代报接受现有直接授权或有效 global 委派，撤销或离职后旧上下文不能继续授权。
- 非 Root 代报必须使用 `work:report_for_worker`，并且该任务成员快照确含临时人员；纯正式工任务不能借此代报。
- 旧任务按当时成员类型快照判断，不要求临时档案现在仍 active；新分配仍执行原有效人员过滤和数据库约束。
- 正式工只能报本人已分配任务，整查／其他工艺继续使用 `tail_inspection:report`。Root 保留现有合法代报能力，退役的独立整查角色不会恢复权限。

服务、API、数量上限、订单版本、幂等及工资核量流程不变。迁移没有数据回填，也不恢复人员、不自动改派、不创建报数或工资。已发生的人员停用、角色变化及任务快照均不重写。

main 的现有维护工具要求每条新迁移有精确 checksum 和 DDL 权限计划，因此一并登记 0231 的维护计划：沿用停流量、备份、事务 DDL，不宣称在线兼容；检查 public schema CREATE／USAGE、现有守卫函数拥有权及 plpgsql USAGE。生产更新前必须先安装包含这条新计划的维护工具，旧工具会在进入维护前安全拒绝。之后仍使用匹配本次 main manifest 的发布包。这只准备既有发布工具的准入元数据，不执行部署，也不修改发布控制流程。

## 隔离回归与验收边界

`tests/integration/temporary-special-proxy-postgres.test.ts` 使用无 superuser／bypassrls／createdb／createrole 权限的测试角色，实际执行 main 全量 0230 迁移、复现旧失败，再追加 0231。旧迁移的 checksum／applied_at 及业务事实逐项保持。

回归覆盖单项和混批、整查和其他工艺、停用临时档案旧任务与新分配拒绝、正式工本人和 Root、无权／纯正式他人代报拒绝、审计绑定、当前身份、有效和撤销委派、模块只读、superseded 任务、数量上限、过期版本、真实数据库拒绝后的整批回滚及同 key 重试、退回重报链、N05／N06 后工资来源不重复。

原子失败场景只在隔离测试库临时添加一个 CHECK，模拟下游数据库拒绝；不禁用或替换任何生产守卫。测试结束恢复该测试约束。测试中的身份变化和成员策略绑定同样仅发生在隔离库，事务回滚。

本地 PG13／PG16 验证、静态检查及测试结果见本次交付记录。它们不等于 GitHub Gate、独立 Review、部署或现场验收。生产更新后应由实际业务办理人在原任务提交，不能用后台预填数字替代业务验收。

## main 与 release 的迁移兼容边界

本次 main 0231 的完整身份是 `0231_temporary_special_process_proxy_reporting`；数字生产 release 已有不同的 `0231_digital_order_closure`。本热修不引入 release 的表、SLA 代码或迁移，不改变任何旧 migration 身份或校验和，也不声称已完成 release 同步。

后续同步必须在独立的迁移集成范围中保留两条 0231 的原文件名和校验和：

1. 将本次 main 0231 的完整身份与原 checksum 登记到 release 的 main extension lane；不能只登记一个编号或改名伪装迁移已应用。
2. release `904978d6` 已支持动态同号配对；登记本次精确身份后复核其配对准入即可，不需要在本热修扩展策略代码。未登记的同号身份会安全拒绝。main 当前旧策略保持原样，本次不将 release 治理代码带入生产热修。
3. 验证 main0230／main0231 和 release 实际库存分别升级到同一集成 manifest，保留每条原 applied_at／checksum，重跑零新增，拒绝未知历史、漂移及不完整分支库存。
4. 最终守卫必须保留本修复与 release 后续权限规则的全部语义；不能让后续迁移重新覆盖成旧的只允许 worker 整查规则。

因此本 PR 可以独立作为 main 0230→0231 热修接受验证；它不是 release 部署包。后续 release 集成未完成前，不将此 main 包用于 Acceptance，也不将数字生产 schema 复制到正式库。

## main 当前 CI 与交付顺序

本次读取的是 main 的 `.github/workflows/full-gate.yml`：PR 目标为 main 且标题 `[FULL]` 时，opened／synchronize／reopened／edited 触发 Full Gate；Quick Gate 对 `[FULL]` 跳过。该版本没有排除 draft 的条件。新增 PostgreSQL 测试路径会被现有 risk map 自动纳入 mapped regressions，无需改 CI 配置。

先完成本地完整修复和定向验证，交父窗口独立审查完整 diff；审查完成后再集中推送并开 draft `[FULL]` PR。GitHub Codex Review 和最终 Head 的 CI 按当前授权核验；超过 15 分钟的 Review 先核旧回执，再按用户长期授权重开，避免重复已完成的审查。不自行提交 APPROVED、合并或部署。
