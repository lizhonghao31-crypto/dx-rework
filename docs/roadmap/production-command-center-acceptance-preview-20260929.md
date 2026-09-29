# 生产管理座舱｜Acceptance 真实页面视觉验收

## 目标

把已认可的生产管理座舱概念图落到未来正式复用的 React 组件，并在独立 Acceptance/UAT 环境提供真实可访问页面。

## Acceptance 地址

相对路径固定为：

`/ui/acceptance/production-command-center`

实际域名来自受保护的 `DX_REWORK_ACCEPTANCE_PUBLIC_URL`。仓库不保存该域名值。

## 安全边界

- 页面不加入正式 App 路由和正式导航。
- 页面先探测 `acceptance/control/status`。
- Acceptance 环境该接口返回 200 或未持控制凭证时的 401，页面才展示座舱。
- 正式生产没有该控制接口，返回404时只显示“Acceptance Only / 未启用”，不会展示座舱样板。
- 数据来自固定 demo source，不访问生产业务 API。

## 视觉证据

真实 Acceptance 候选部署后，现有 live regression 额外生成：

- `05-production-command-center-desktop-1536x960.png`
- `06-production-command-center-mobile-390x844.png`

截图只截取真实 `.production-command-shell`，不把 Acceptance 提示条混入视觉对照。

## 下一步

拿到首轮真实截图后，以此前已认可的概念图为唯一视觉参考，逐项调整区域比例、表格密度、详情/风险栏宽度、节点流程、字体与间距。PC版先收口，再处理移动端。
