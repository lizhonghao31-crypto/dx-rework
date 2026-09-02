# 我的待办数量角标施工预检

repository: lizhonghao31-crypto/dx-rework  
base branch: main  
base SHA: 14b26060fb7b1d349e5aa6cf0d00658eda23b982  
working branch: fix/todo-count-badge  
task scope: 将共享“我的待办”提示改为由真实未完成事项驱动的 iOS 式数字角标  
allowed files: packages/contracts/src/todos.ts; apps/api/src/todos/service.ts; apps/api/src/todos/routes.ts; apps/web/src/components.tsx; apps/web/src/shell-navigation.css; apps/web/src/todo-new-indicator.ts; tests/unit/todo-indicator.test.ts; tests/unit/todo-new-indicator.test.ts; tests/integration/todo-routes.test.ts; docs/decisions/todo-count-badge-20260902.md; docs/engineering/todo-count-badge-preflight.md; docs/evidence/todo-count-badge-desktop.svg; docs/evidence/todo-count-badge-mobile.svg; docs/evidence/todo-count-badge-ui.md  
forbidden files: 数据库 migrations 与 manifest；待办创建/完成/取消/转交状态机；角色与 capability；钉钉通知；金额数量业务口径；部署、ECS、密钥、GitHub Actions；其它页面布局和调色盘

## 执行与回滚

- 执行方式：本地私有仓库认证不可用，ChatGPT 控制器按固定流程通过已授权 GitHub 能力直接施工。
- 门禁等级：共享导航与跨模块待办提示，创建 PR 后必须添加 full-gate 标签。
- Codex Review：本次不改变待办路由或状态机，但影响共享平台壳；Full Gate 全绿后由业务负责人决定并手动触发，ChatGPT 不代为触发。
- 回滚方式：回退本 PR；无数据迁移或生产数据修复。
