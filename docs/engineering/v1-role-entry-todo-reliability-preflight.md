# 1.0 角色入口与钉钉待办可靠性预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: f792f921f33cab100b21b91b0ef440680ae9fd82
working branch: fix/v1-role-entry-todo-reliability
task scope: 统一非一线角色入口与导航，补齐财务总监和印绣花/洗水跟单权限，并让已分配工人稳定收到全中文钉钉待办。
allowed files: apps/api/migrations/0091_role_entry_todo_reliability.sql; apps/api/src/platform/migration-manifest.json; apps/api/src/rework/work-reporting-service.ts; apps/web/src/App.tsx; apps/web/src/components.tsx; apps/web/src/landing-target.ts; packages/contracts/src/todo-presentation.ts; tests/unit/landing-target.test.ts; tests/unit/todo-presentation.test.ts; tests/unit/role-navigation-source.test.ts; tests/integration/work-reporting-postgres.test.ts; docs/engineering/v1-role-entry-todo-reliability-preflight.md
forbidden files: 其余业务状态机、工资金额计算、责任判定、root 权限绕过、ERP、ECS、钉钉应用配置与生产数据

## 业务规则变更

- 删除“管理共享座舱”作为页面入口及默认落点；有 todo:view 的非一线角色统一进入“我的待办”。
- 财务总监继承财务全局查看的全部能力，并额外获得工资查看与导出能力；保留既有扣款异常特批能力。
- 印绣花/洗水跟单增加 todo:view，保留既有外部责任能力。
- 工人/尾查人员分配生效后，按实名内部账号创建本人待办；临时工不创建钉钉待办。
- 钉钉待办标题、描述和终态原因使用全中文业务文案。
- root 保持现有超级用户行为，不新增限制。
