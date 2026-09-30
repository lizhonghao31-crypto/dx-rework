# 员工访问与角色生命周期预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 0a3283d6da3c44ab0f7387d70efff85c56986c34
working branch: feat/employee-access-role-lifecycle
task scope: 员工账号默认停用，并使账号启停状态随有效角色或临时授权自动收敛
allowed files: apps/api/migrations/0089_employee_access_role_lifecycle.sql; apps/api/src/platform/migration-manifest.json; apps/api/src/auth/postgres-store.ts; apps/api/src/server.ts; apps/api/src/access/service.ts; apps/api/src/access/employee-access-service.ts; packages/contracts/src/employee-access.ts; apps/web/src/employee-access-page.tsx; tests/integration/employee-access-lifecycle-postgres.test.ts; tests/integration/access-postgres.test.ts; tests/unit/employee-access-active-role-filter.test.ts; docs/engineering/employee-access-role-lifecycle-preflight.md
forbidden files: 订单、收货、返工状态机、工资、财务、供应商、附件及其他业务页面
```

## 业务规则

- 新员工账号默认停用；首次获得当前有效业务角色或临时授权时自动启用。
- 最后一个有效角色或临时授权被撤销后自动停用，并撤销现有登录会话。
- 已有且有效的角色员工保持启用，无需重新授权。
- Root 永久启用并受数据库约束保护，不参与自动停用。
- 人工停用与“没有角色而自动停用”分开记录；人工停用必须先恢复访问，普通授权不能绕过。
- 临时授权只在有效时间窗内计入；未来授权不会提前开放访问，过期授权在再次鉴权时收敛并拒绝访问。

## 回滚与风险

迁移新增字段、函数并改变 `app_users.enabled` 默认值。应用回滚时必须同时回滚生命周期服务逻辑；数据库字段可保留兼容，恢复默认值前需先明确未授权账号的处置口径。主要风险集中在迁移回填、Root 锁定和最后授权撤销，因此由 PostgreSQL 集成测试及 GitHub Full Gate 验证。
