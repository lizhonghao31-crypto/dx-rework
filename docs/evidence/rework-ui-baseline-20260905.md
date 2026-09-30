# 返工 UI 基线纠偏验证记录

本轮基线：main@5ae41c64eb286bee4392cc5a49fbc2fd11b61a8e。

## 已执行

- 按远端main读取155个前端和共享包文件，在独立目录验证；未复用未提交SSP-06功能。
- npm ci按仓库lock安装依赖，未改依赖或lock。
- 共享包build通过；web typecheck通过；web生产build通过。
- components.tsx ESLint通过。
- 6个现有测试文件共17项通过：supplier-center-model、sourcing-mobile-workspace、sourcing-pc-form-approval-contract、role-navigation-source、workflow-shell-layout、mobile-bottom-navigation。
- 逐文件diff审查；返工原有普通控件高度以同值token替换，其它业务逻辑保持不变。
- 在已登录验收浏览器只读测量原返工导航：返工单看板框高约69.69px，标题13px/20px，副标题11px/14.85px且两行；据此约束同级导航的长文案，不使用臆测的单行高度。
- 合同原件已提取全文并渲染整页检查，字段和条款对照见sourcing-contract-field-audit-v1.1.md。

## 尚未通过

- 当前Head的GitHub Full Gate由PR的full-gate标签启动，结果以GitHub运行记录为准。
- 新版真实浏览器五尺寸截图未取得：云浏览器明确以URL安全策略拒绝本地预览，并禁止绕过；未改用其它浏览器控制路径绕过限制。
- 不能宣称全平台视觉验收完成或合同数据链已修复；本PR不修改节点1/3接口、数据库、PDF模板或历史合同。

## 风险与回滚

共享导航的超长说明统一最多两行，完整说明通过title保留；需在部署后的长文案和移动导航中验收。CSS构建和静态测试不能覆盖真实字体与布局差异。回滚本PR恢复UI及规则文件，不涉及业务数据迁移。

本地Node为24，仓库要求Node22；类型检查与构建已通过，本地结果不替代GitHub规定运行环境的Full Gate。
