# 尾部主管返工单看板导航预检

- Repository: `lizhonghao31-crypto/dx-rework`
- Base branch: `main`
- Base SHA: `9957552d3b40d95b31f9eb5a19160c868f002898`
- Working branch: `fix/v1-tail-supervisor-rework-navigation`

## 任务范围

- 将既有 `dashboard:site:read` 权限映射到“返工单看板”导航。
- 使尾部主管在电脑侧栏和手机底部导航看到“返工单看板”。
- 保留尾部主管现有“我的待办”“订单看板”“工资管理”等权限与入口。
- 不因此授予“财务报表”入口。

## 允许修改

- `apps/web/src/components.tsx`
- `tests/unit/role-navigation-source.test.ts`
- 本预检文件

## 禁止修改

- 角色与能力数据、数据库迁移
- 工人待办或钉钉通知
- 订单、工资、财务的业务权限
- 页面布局、业务状态、部署配置和密钥

## 验证边界

尾部主管在基础权限迁移中已经拥有 `dashboard:site:read`；本 PR 只修复导航遗漏。桌面与移动端复用同一导航数组，因此一次授权映射同时覆盖电脑侧栏和手机底栏。
