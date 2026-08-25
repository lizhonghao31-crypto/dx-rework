# 1.0 上线前性能 PR-10 预检与证据

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: d1df9b1fe360ff5d742aefcc4e748ee2e5c02477
working branch: codex/v1-prelaunch-performance-pr10
task scope: 消除页面首次人为等待、复用已验证会话，并在筛选刷新期间保留已展示数据
allowed files: apps/web/src/auth.tsx; apps/web/src/components.tsx; apps/web/src/use-debounced-value.ts; apps/web/src/reporting/rework-query-page.tsx; apps/web/src/order-board-page.tsx; apps/web/src/reporting/workflow-queue-page.tsx; apps/web/src/wages/wage-period-list.tsx; tests/unit/v1-prelaunch-performance-pr10.test.ts; docs/engineering/v1-prelaunch-performance-pr10-preflight.md
forbidden files: apps/api/**; packages/**; infra/**; migrations/**; all CSS; business contracts; workflow state machine; DingTalk provider/outbox; production configuration
```

## 现场基线

2026-08-24 在 staging 以登录后真实页面、从点击到业务数据可操作为口径核验：

- 返工单看板首次进入约 10.7 秒，重复进入约 4.3–4.7 秒。
- 我的待办约 4.1 秒。
- 订单看板约 3.7 秒。
- 普通与极端订单详情均约 4.1 秒，订单体量不是主要决定因素。

这些数字包含网络、API、数据库和渲染，不等同于单条 SQL 时间。PR-10 只处理已经能从代码直接证明的低风险前端等待和重复请求；API/SQL 与提交链分别进入后续独立 PR。

## 本次控制

- 页面初次进入立即发起业务请求；180–200ms 防抖只作用于用户继续输入的搜索文字。
- `AuthGate`、`Shell`、返工单看板和订单看板共用当前页面生命周期内已验证的会话 Promise，不建立跨刷新、跨账号或业务数据缓存。
- 后端接口仍对每个业务请求执行原有授权，前端会话复用只用于导航与按钮可见性。
- 筛选或手动刷新时保留上一份成功数据，响应成功后原子替换；请求取消与失败处理维持原契约。
- 不改变 UI 布局、业务状态、权限、数量、金额、审计或钉钉通知规则。

## 回滚

该 PR 不含迁移或数据写入变更，可通过回滚单个 squash merge 完整恢复原有加载行为。
