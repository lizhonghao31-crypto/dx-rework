# PR-14 Preflight — Root 收货更正与删除

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: f4d84bb267e9d9477fe6c57ec047f32c0bef3d6c
working branch: feat/root-receiving-correction
task scope: Root 可在返工发起前更正或逻辑删除收货批次，返工发起后永久锁定
allowed files: apps/api/migrations/0088_root_receiving_correction.sql; apps/api/src/platform/migration-manifest.json; apps/api/src/receiving/receiving-service.ts; apps/api/src/receiving/receiving-routes.ts; apps/api/src/rework/rework-business-detail-service.ts; apps/web/src/order-board-page.tsx; apps/web/src/order-board-page.css; tests/integration/receiving-postgres.test.ts; tests/unit/v1-prelaunch-receiving-rework-contract.test.ts; tests/unit/v1-prelaunch-mobile-filter-order-detail.test.ts; docs/engineering/pr-14-preflight.md
forbidden files: 生产配置、密钥、钉钉配置、既有迁移、工资与责任判定模块、部署文件
```

本次保留 `receiving_receipts` 原始事实和已绑定收货图片；更正只写批次聚合调整量，删除为逻辑删除。服务端与数据库守卫均以“存在任何关联返工记录”为永久锁定条件，包含已取消或已删除的返工记录。
