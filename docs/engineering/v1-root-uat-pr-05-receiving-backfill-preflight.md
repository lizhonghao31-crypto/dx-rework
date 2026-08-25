# PR-05 Preflight：收货历史补录

## 基线

- Repository：`lizhonghao31-crypto/dx-rework`
- Base branch：`main`
- Base SHA：`ef6937c6f6f3a9b2045686104733516e451388e6`
- Branch：`feat/v1-receiving-backfill-two-day-window`

## 单一目标

在现有收货页增加最近两个自然日的历史订单补录，并由服务端锁定时间边界和独立批次语义。

## 允许修改

- `apps/web/src/receiving-page.tsx`
- `apps/web/src/receiving-page.css`
- `apps/api/src/receiving/receiving-routes.ts`
- `apps/api/src/receiving/receiving-service.ts`
- `tests/unit/v1-root-uat-receiving-backfill.test.ts`
- `tests/integration/receiving-postgres.test.ts`
- `docs/requirements/v1-root-uat-receiving-backfill-2026-08-25.md`
- `docs/engineering/v1-root-uat-pr-05-receiving-backfill-preflight.md`

## 禁止修改

- 数据库表、迁移历史和不可变收货事实保护。
- 订单看板、Root 修改/删除和返工入口。
- 角色、capability、登录与授权边界。
- 返工、工资、责任、钉钉和附件治理逻辑。

## 验证门槛

- 页面保留原收货入口，并在其下增加补录入口和限定日期字段。
- 服务端仅接受昨天、前天，拒绝今天、三天前及无效日期。
- 补录同款时形成独立批次，普通收货路径保持原行为。
- 补录继续经过幂等、图片绑定和操作审计。
- 修改文件 lint、定向测试、Quick Gate、Full Gate 全绿。
