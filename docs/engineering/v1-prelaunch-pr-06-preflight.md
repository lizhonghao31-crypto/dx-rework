# 1.0 上线前 PR-06 施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: ccdeb377865d0bac44b59ef0d9e1b20c157a7a85
working branch: feat/v1-prelaunch-ui-workspace-clarity
task scope: 收紧 N05/N06 与订单详情 UI，并让移动端优先显示当前办理区，同时修复历史 IE 核价节点跳转。
allowed files: apps/web/src/App.tsx; apps/web/src/rework-detail-page.tsx; apps/web/src/rework-detail-compact.css; apps/web/src/whole-order-review-panel.tsx; apps/web/src/styles.css; apps/web/src/process-configuration-form.tsx; apps/web/src/process-worker-assignment-form.tsx; tests/unit/*pr-06*; tests/unit/order-detail-information-architecture.test.ts; tests/unit/v1-prelaunch-effective-quantity.test.ts; docs/engineering/v1-prelaunch-pr-06-preflight.md
forbidden files: apps/api/**; packages/contracts/**; packages/domain/**; migrations/**; scripts/migrations/**; apps/web/src/responsibility-determination*; apps/web/src/receiving-page*; apps/web/src/wages/**; all DingTalk, permission, Root, owner-signature and settlement logic
```

## 基线证据

- GitHub `main` 最新提交：`ccdeb377865d0bac44b59ef0d9e1b20c157a7a85`。
- 当前托管工作区没有可用 GitHub 凭据，但本地 PR-05 头所修改的 12 个文件 blob SHA 均与当前 `main` 完全一致；本地施工用于测试，发布时从 GitHub 精确 `main` SHA 创建远程分支并仅写入本 PR 变更。
- 既有九节点流程、权限、工资、责任、老板签字、收货证据链与调色板均不改变。

## 增量边界

- 只在订单详情与 N05/N06 现有组件上增加局部状态、局部 class 和定向样式。
- 不引入 UI 组件库，不新增调色板，不做全局组件重构。
- 桌面端保留订单图片与流程展开；移动端首次进入默认折叠，用户本页手动展开后保持状态。
- 图片、流程与节点办理的接口、权限和审计逻辑保持不变。
