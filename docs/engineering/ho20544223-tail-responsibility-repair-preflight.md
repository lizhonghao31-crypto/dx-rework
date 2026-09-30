# HO20544223 整查责任金额修复 Preflight

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 245b48db3d05fcd63a5202aed4924760a569b146
working branch: fix/ho20544223-tail-responsibility-repair
task scope: 追加审计式修复 HO20544223 已完成责任快照，使整查工资按加工厂 100% × 1.2 进入责任与外扣。
allowed files: apps/api/migrations/0114_ho20544223_tail_responsibility_repair.sql; apps/api/src/platform/migration-manifest.json; tests/unit/ho20544223-tail-responsibility-repair.test.ts; docs/engineering/ho20544223-tail-responsibility-repair-preflight.md
forbidden files: 其他业务服务、前端、待办、工资月结、报价选厂、收货、钉钉、共享导航、GitHub Actions
```

## 数据边界

- 仅命中 `RW-2026-0826-001 / HO20544223`。
- 仅在订单已完成、整查由加工厂承担、当前责任和外扣均为 ¥1,076.16、整查工资基数为 ¥390.40、尚无实际扣款或结案时执行。
- 追加整查责任明细 ¥468.48，责任与外扣均校验为 ¥1,544.64。
- 不删除旧工序、责任、扣款、工资、签字或审计事实；新增不可变的业务纠正记录。
- 纠正记录保存唯一 Root/老板授权人的稳定用户ID与角色快照，明确授权新增的 ¥468.48。
- 迁移对外扣案例加 `FOR UPDATE` 行锁，并在写入前再次核验没有扣款或结案，阻断并发竞态。
- 任一线上事实与已核验快照不符时，迁移直接失败，不猜测、不部分写入。

## 门禁

- 数据迁移、财务金额、不可变责任事实：必须 Full Gate。
- Full Gate 全绿后必须由业务负责人手动触发一次 Codex Review。
