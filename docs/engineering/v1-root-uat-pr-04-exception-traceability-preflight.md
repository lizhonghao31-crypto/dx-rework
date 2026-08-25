# PR-04 Preflight：异常事实追溯

## 基线

- Repository：`lizhonghao31-crypto/dx-rework`
- Base branch：`main`
- Base SHA：`481d8b06f7ee77a5a345e2563f792ec6bc58fa05`
- Branch：`fix/v1-root-uat-exception-traceability`

## 单一目标

在既有系统异常页补全事实追溯字段，并让管理页面请求失败时保留可复制的请求 ID。

## 允许修改

- `apps/api/src/admin-console-service.ts`
- `apps/web/src/admin-console-page.tsx`
- `packages/contracts/src/admin-console.ts`
- `tests/integration/admin-console-routes.test.ts`
- `tests/unit/admin-console-service.test.ts`
- `tests/unit/v1-root-uat-exception-traceability.test.ts`
- `docs/requirements/v1-root-uat-exception-traceability-2026-08-25.md`
- `docs/engineering/v1-root-uat-pr-04-exception-traceability-preflight.md`

## 禁止修改

- 异常来源表、迁移历史、后台重试和钉钉投递逻辑。
- 返工、工资、责任、收货、附件绑定和订单状态机。
- 角色能力、授权规则、审计写入和敏感数据查看边界。
- 通用监控、告警、自动判责、自动处罚或自动关闭异常。

## 验证门槛

- 合同与路由响应覆盖新增追溯字段。
- 服务层覆盖关联订单、请求 ID、状态映射及错误脱敏。
- 页面合同覆盖请求 ID 展示/复制和返工单直达入口。
- 修改文件 lint、定向测试、Quick Gate、Full Gate 全绿。
