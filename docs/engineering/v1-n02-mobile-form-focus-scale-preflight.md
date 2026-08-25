# N02 移动端输入框保持页面比例：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: e79cae7a106c438c9ab3a752fbf44faed4fdd25d
working branch: fix/v1-n02-mobile-input-font-size
task scope: 仅 N02 移动端可输入控件统一为 16px，避免聚焦时自动放大页面
allowed files: apps/web/src/process-worker-assignment-mobile-sheet.css；对应单元测试、需求与预检文档
forbidden files: 全局样式、其他业务节点、桌面端、viewport 缩放权限、后端、数据库、权限、流程与部署配置
```

本 PR 只向 N02 页面作用域增量增加移动端表单字号规则，不改变其他页面。
