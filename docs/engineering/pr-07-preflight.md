# PR-07 施工预检：工人分配与上数

- 路线：PR-07；GitHub 仓库：`lizhonghao31-crypto/dx-rework`。
- 基线：`main@2dd6fb538a64e1319231d7064fd3a0d7d4c63090`（已合并 PR-06）。
- 工作分支：`codex/pr-07-worker-assignment-reporting`。
- 范围：个人/集体任务、成员快照、临时工授权代录、独立上数、补录时间校验、幂等及服务端并发上限校验。
- 明确排除：整单审核与数量调整、责任、工资月结、扣款、ERP 和生产发布。
- 回滚：未部署时关闭 PR；部署后保留已写入任务/上数/成员快照，采用前向迁移停用入口，不删除历史事实。

## 验收约束

1. 个人任务仅一人；集体任务保留每条上数对应的成员快照和独立分摊明细。
2. 上数使用事务锁定同一返工单工序的累计数量，任意并发不得超计划。
3. 临时工无登录入口，只能由具有 `work:report_for_worker` 的尾部主管代录。
4. 工人只能读取并上报本人已分配任务；完工时间最多补录七天。

## 第四轮 Codex Review 修复预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 2dd6fb538a64e1319231d7064fd3a0d7d4c63090
working branch: codex/pr-07-worker-assignment-reporting
current review head: a1337920beda0079de9d2deca58a63a160c2b692
task scope: 修复本地完工时间、任务分配重试幂等、工作事实 ERP 映射预留及最小小时数的 40 人精确分摊
allowed files: apps/api/migrations/0008_worker_assignment_reporting.sql, apps/api/src/platform/migration-manifest.json, apps/api/src/rework/work-reporting-service.ts, apps/web/src/work-reporting-form.tsx, apps/web/src/work-reporting-submission.ts, tests/unit/work-reporting.test.ts, tests/unit/rework-contracts.test.ts, tests/integration/work-reporting-postgres.test.ts, docs/engineering/pr-07-preflight.md
forbidden files: 0001–0007 历史迁移、领域状态机定义、设计 token、生产配置、PR-08 及后续的审核/责任/工资模块
```

- 回滚：未部署时关闭 PR；已部署时保留任务、上数与金额快照事实，仅通过前向补丁停用入口，不删除业务记录。
