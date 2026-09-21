# UI-01 财务核对布局与手机日期

## 预检
- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 5bba05352d1a9889dc11ae338d6865c420a36e6c
- working branch: fix/ui01-finance-layout
- task scope: 财务核对紧凑展示、等宽双按钮与差异弹窗；手机顶部双日期并排。
- allowed files: sourcing-workspace-page.tsx、sourcing-governed.css、新增 sourcing-finance-difference-dialog.tsx、UI需求和本记录。
- forbidden files: API、数据库、权限、金额计算、业务流程、订单列表、其他模块、部署配置。
- gate class: FULL；全绿后一次 Codex Review。

## 实现
- 财务批准事实与合同仍只读，原事实来源、逐款筛选条件和展示精度保持不变。旧灰卡替换为共享 ResponsiveFactsTable 与限定财务区域的无内框信息栏。
- 核对一致和发现不一致按钮两列等宽，两端均保持清晰可见。
- 差异内容迁入原生 dialog，沿用 system-dialog 样式；浏览器提供焦点限制和背景交互隔离，关闭后恢复背景滚动。勾选／说明校验、API payload、幂等处理保持原逻辑。提交中禁止编辑、取消和 Escape；错误反馈保留在弹窗内。
- 日期仅修改手机样式，同栏左右并列，340px 以下回退整行保证完整可读。

## 验证边界
- 定向 sourcing 套件、类型检查、lint、生产构建与 Full Gate，结果见 PR 当前 Head。
- 无真实浏览器视觉截图；此前本地预览被自动审批拒绝，不能绕过。不得把 Gate 或 Review 等同于视觉验收。
- 用户负责部署。
