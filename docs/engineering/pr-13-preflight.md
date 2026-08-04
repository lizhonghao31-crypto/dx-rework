# PR-13 施工预检：钉钉待办、通知与催办

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: d4bb59e682fe7b38ed919719b10706596541de21
working branch: codex/pr-13-todo-notification
task scope: 完成事件矩阵内的待办投影、历史补建和端到端验收；不改既有业务状态机
allowed files: docs/plan/pr-13-*.md, docs/engineering/pr-13-preflight.md, apps/api/migrations/0026_todo_notification_foundation.sql, apps/api/src/todos/**, apps/api/src/rework/**, apps/api/src/wages/**, apps/api/src/app.ts, apps/api/src/server.ts, apps/api/src/platform/migration-manifest.json, apps/api/src/tools/repositories.ts, packages/contracts/src/todos.ts, packages/contracts/src/index.ts, package.json, tests/**, scripts/**
forbidden files: apps/web/**, apps/api/migrations/0001_* 至 0025_*, 既有业务迁移、生产配置、钉钉应用配置、ERP 适配与部署文件
```

## 基线核验

- GitHub `main` 已通过仓库 API 核验为 `d4bb59e682fe7b38ed919719b10706596541de21`（PR #20 合并提交）；迁移清单止于 `0025_wage_completion_month_backfill_access`。
- 当前恢复工作区的 0026 及待办候选尚未提交；本轮只能在此候选上增量施工，创建 Draft PR 前必须重新建立 Git 基线并核对全部差异。
- 工资角色以 PR-12 的真实模型为准：`administrative_clerk` + `wage:administrative_review` / `wage:adjustment_approve`，以及 `wage_month_close_accountant` + `wage:month_close`。不得误映射到 PR-05 遗留的 `payroll_review` / `payroll_close`。
- 责任待办和高倍率待办的可核验 source action 是 `rework.responsibility.draft`：草稿创建时决定正式处理人并暴露高倍率待确认事实；`rework.responsibility.high_multiplier.confirm` 是其完成动作，不是创建动作。

## 回滚

在 Draft PR 合并前，关闭 PR 并丢弃候选即可。`0026` 一旦应用，只能新增前向迁移停用或修复入口；不得重写待办、转交、投递、策略或审计事实。
