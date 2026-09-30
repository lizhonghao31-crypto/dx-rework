# 数字生产平台前置施工：UI视觉验收底座

- 基准：main@51fe1a8fbfa115eaa06bad6f2513120e4de8a6bb
- 范围：仅建立生产管理座舱真实React组件的离线视觉样板、单元检查与手动截图工作流。
- 不修改：生产API、数据库、权限、订单状态机、正式导航、正式数据、正式通知。
- 目的：把“认可图片 → 真实组件 → 浏览器截图 → 对照修正”变成可重复执行链路，避免再次用静态图或代码推测代替视觉验收。

## 视觉样板原则

1. 组件位于 apps/web/src，后续正式页面复用同一组件，不重新抄一套HTML。
2. fixture只提供合成数据，不访问生产API。
3. 节点完成期限与整单风险分开显示；后续节点未进入时不得提前倒计时。
4. 手动GitHub Actions只生成HTML和桌面/移动截图，不部署、不读取Secrets、不访问生产资源。
5. 用户认可真实代码页面后，后续视觉回归以该代码截图为基准，不以生成图继续漂移。

## 手动截图

GitHub Actions → “PR preview artifact and optional deployment” → Run workflow，选择目标ref。
产物：production-command-center-visual-<SHA>，包含preview HTML、1536×960桌面截图和390×844移动截图。

## 下一步

本PR通过后，再独立核验Acceptance实际部署资源与测试数据库身份，之后建设验收站点部署；不在本PR同时修改业务流程。
