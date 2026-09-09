# 财务总监样衣只读权限审计 · 2026-09-09

## 来源

Acceptance Lab T04 完成后的首批全角色权限治理。批准矩阵要求 `finance_director` 可读取样衣基本资料、财务金额与审计信息，同时禁止样衣新增、批量新增、借还、修改、财务修正、处置、审批、遗失结案与归档。

## 本 PR 修复范围

- 数据库仅为 `finance_director` 新增 `sample:view_basic`、`sample:view_finance`、`sample:view_audit` 三项读能力。
- 服务端 `SAMPLE_ROLE_CAPABILITIES` 同步加入相同三项读能力，形成角色 + capability 双重校验。
- 样衣模块入口、普通读取路由与金额读取路由加入 `finance_director`，仍分别要求对应读 capability。
- 样衣分析读取加入 `finance_director`，仍要求 `sample:view_finance`。
- 样衣交接、单件新增、批量新增继续只允许原有写角色，不把 `finance_director` 当作 `sample_finance` 的别名。
- 新增回归测试锁定 SQL 授权、服务端 allowlist、页面路由与导航边界。

## 明确不做

- 不修改任何真实员工的角色分配。
- 不授予任何 `sample:*` 写 capability。
- 不修改 Root 身份或 Root 既有调试能力。
- 不修改生产业务数据、样衣数据、订单状态机或真实钉钉外发。
- 不修改 Acceptance 批准矩阵来迁就当前实现；正式实现向既定批准目标对齐。

## 验收条件

1. Full Gate exact Head 全绿，包含本次迁移触发的 PostgreSQL / migration 校验。
2. `finance_director`：样衣基本资料、金额与审计读取允许；所有样衣写 capability 保持禁止。
3. `sample_finance`、`sample_administrative`、`sample_designer`、`sample_approver`、`owner_group` 与 Root 既有边界不回归。
4. 合并后用 Acceptance Lab 重新运行 `finance-director` 权限矩阵与财务总监样衣代表性场景，证据追加而不覆盖历史失败。

## 后续

下一独立权限治理 PR 处理“返工列表可见但详情读取 403”的一致性，不在本 PR 混入返工权限扩张。
