# 移动端操作控件尺寸与自适应收口预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 6d3543a766f888fcd9469fcb2e453998fedf865a
working branch: fix/mobile-operation-controls-responsive
task scope: 统一移动端操作区同类控件尺寸，并消除不同手机宽度下由固定最小宽度和设备断点造成的挤压、粘连与溢出
allowed files: packages/ui/src/components.css; apps/web/src/styles.css; apps/web/src/frontline-task-page.css; apps/web/src/reporting/rework-query-mobile.css; tests/unit/mobile-operation-controls-responsive.test.ts; tests/unit/v1-prelaunch-mobile-filter-order-detail.test.ts; docs/engineering/mobile-operation-controls-responsive-preflight.md
forbidden files: 底部导航、分页、API、contracts、数据库、权限、业务状态机、金额数量逻辑、钉钉认证、部署与 GitHub Actions
```

## 已确认的 UI 决策

- 返工看板关键词框、下拉框和日期框在手机端采用同一 36px 视觉高度；关键词输入只保留 `InsetField` 外层一个框，不再叠加内层边框。
- 操作页面不再依赖仅覆盖 390px 或 420px 的具体设备断点；字段网格按容器可用宽度自动换列，所有网格子项允许收缩且保留固定间距。
- 小屏幕当前可用的操作路径、字段、按钮、顺序和业务行为保持不变；只调整同类控件尺寸与响应式排版。
- 桌面端现有布局保持不变；不触碰底部导航与分页。

## 必要旧逻辑触碰与回滚

- 必须覆盖共享 `InsetField` 的手机端固定 `min-width: 250px`，否则多列操作区在部分手机宽度下仍会溢出。
- 必须把返工发起表单和一线任务页的设备专用断点改为基于可用宽度的自动换列，否则 390px 正常而 430px 失效的问题无法根治。
- 回滚方式：整体回退本 PR；不涉及数据迁移、业务状态或生产配置恢复。

## 验收边界

- 静态验证同类控件只有一个外框，手机端关键词、下拉和日期控件视觉高度一致。
- 在 375px、393px、414px、430px 与 560px 宽度验证：无水平溢出、无控件重叠、相邻控件间距不为零。
- 覆盖返工看板筛选、返工发起表单、工序配置与一线报工上下文；其他已使用共享 `InsetField` 的手机操作区同步获得最小宽度修复。
