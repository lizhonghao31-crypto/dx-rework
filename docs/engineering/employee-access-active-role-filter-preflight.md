# 员工权限当前有效角色筛选预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 650979a6cc0d158eff7bab5e9d1c3d27b35bfa24
working branch: feat/employee-access-active-role-filter
task scope: 员工权限管理新增“当前生效且已分配角色”筛选及同口径数量
allowed files: apps/web/src/employee-access-page.tsx; apps/web/src/employee-access.css; apps/web/src/employee-access-filter.ts; tests/unit/employee-access-active-role-filter.test.ts; docs/engineering/employee-access-active-role-filter-preflight.md
forbidden files: apps/api/**; packages/contracts/**; apps/api/migrations/**; 其他业务页面与流程状态机
```

## 口径

“当前生效且已分配角色”必须同时满足：员工仍在职、钉钉组织身份有效、系统访问已启用，并至少拥有一个接口返回的当前业务角色。接口中的当前业务角色已排除已撤销或已停用角色。

筛选结果与数量必须调用同一个判断函数，搜索只在选定员工范围内继续收窄，不改变原有默认“全部员工”行为。
