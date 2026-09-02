# 我的待办红色角标热修预检

repository: lizhonghao31-crypto/dx-rework  
base branch: main  
base SHA: aa856ee9ab4d4921f945d5e2b4fb7e738e8e51f4  
working branch: fix/todo-badge-ios-red  
task scope: 修复待办角标因引用不存在的颜色变量而呈现蓝色描边的问题  
allowed files: apps/web/src/shell-navigation.css; tests/unit/todo-new-indicator.test.ts; docs/engineering/todo-count-badge-red-hotfix-preflight.md  
forbidden files: API、contracts、数据库、待办状态机、权限、钉钉通知、其它页面布局、调色盘、部署与 GitHub Actions

## 根因与修复

- 根因：`--color-danger` 未在项目中定义，浏览器丢弃背景色；选中态蓝色边框仍生效。
- 修复：角标使用 iOS 红 `#ff3b30` 实心背景和白字，移除蓝色边框，保留绝对定位，不改变导航卡片尺寸。
- 回滚：回退本 PR；无数据影响。
- 门禁：纯 CSS 热修与防回归测试，只需 Quick Gate；不需要 Codex Review。
