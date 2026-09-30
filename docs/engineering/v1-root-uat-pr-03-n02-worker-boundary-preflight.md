# Root UAT PR-03 N02 人员边界与临时工资料补录预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 58e736e423abdbc41cc4eb06b633be56d36e4205
working branch: fix/v1-root-uat-n02-worker-boundary
task scope: 明确 N02 本单人员与全局默认名单边界，并在当前工序内复用既有弹窗补录临时工资料
allowed files: docs/engineering/v1-root-uat-pr-03-n02-worker-boundary-preflight.md; docs/requirements/v1-root-uat-n02-worker-boundary-2026-08-25.md; packages/contracts/src/index.ts; apps/api/src/access/service.ts; apps/api/src/access/routes.ts; apps/api/migrations/0092_temporary_worker_profile_update.sql; apps/api/src/platform/migration-manifest.json; apps/web/src/process-worker-assignment-form.tsx; apps/web/src/process-worker-assignment-form.css; tests/integration/access-routes.test.ts; tests/integration/access-postgres.test.ts; tests/unit/n02-mobile-assignment-sheet.test.ts; tests/unit/v1-prelaunch-default-candidates-frontline.test.ts; tests/unit/v1-root-uat-n02-worker-boundary.test.ts
forbidden files: apps/api/src/rework/**; apps/api/src/receiving/**; apps/api/src/todos/**; apps/web/src/receiving-page.tsx; apps/web/src/master-data-page.tsx; packages/config/**; .github/**
```

## 施工边界

- 本单选择、移除和确认人员不调用默认名单接口；只有明确点击“保存为默认名单”才写入全局默认名单。
- 不新增页面、数据表或个人资料字段；仅为现有临时工字段增加受控读取与更新接口。
- 临时工姓名保持不可修改；保存资料后留在当前 N02 工作区，不刷新整张订单。
- 操作日志只记录资料是否存在，不记录手机号、身份证号或备注正文。
- 数据库迁移只放行匹配审计事件的临时工资料更新，并对既有默认名单显式保存路径对齐现有尾部主管权限。

## 验收证据

- 路由测试覆盖尾部主管允许、缺能力和错误角色拒绝。
- PostgreSQL 测试覆盖受控更新、直接更新拒绝、隐私明文不进入审计，以及尾部主管显式保存默认名单。
- UI 合同测试锁定本单/默认名单文案、唯一写入口及临时工原位补录交互。
- 当前 intended head 完成 Quick Gate 与 Full Gate 后方可合并。
