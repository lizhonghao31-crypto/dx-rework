# 打板创建与详情紧凑排版修正

## 一次预检
- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: d8bcf66e1e9b0b675752d3cc96ada8615b6e0871
- working branch: fix/pattern-compact-layout-20260922
- task scope: 按用户确认方案收紧创建表单、集中详情信息、整理办理区与历史记录。
- allowed files: apps/web/src/pattern-{governed.css,order-create-page.tsx,order-form.tsx,room-orders-page.tsx,round-record.tsx}; tests/unit/pattern-order-presentation.test.ts; 本文档。
- forbidden files: 订单列表函数、pattern-room.css、共享 UI、API、权限、数据库、计算和状态机。
- gate class: FULL（涉及数量、金额展示位置；不改变数据和计算）。

## 已确认方案
- 创建页最大宽度 1080px，电脑端款号/品类/数量/价格同排，日期/客户同排，尺码颜色/版型/参考款号同排；备注两行。
- 白底、细边框、无发光阴影；手机端重排并保留可点击尺寸。
- 顶部集中师傅、日期、创建人、品类、数量或工时、权限允许的价格；可选资料有值才占补充行。
- 图片/流程继续左图右流程，手机图片横滑、流程默认折叠。
- 派工输入框限制宽度，确认分配相邻；更新资料、取消任务等次要操作合并一行。
- 当前轮次下方不重复顶部事实；历史轮次保留自己的完整事实；工人分段、取消费用、节点用时、附件和操作记录保留。
- 订单列表逐字比对保持不变；历史页面仍使用历史投影和只读模式。

## 验证范围
- Web 类型检查、生产构建、定向渲染与导航测试。
- 新增断言：摘要上移后历史仍含工人、取消费用和执行段锚点；权限隐藏的价格不生成展示项。
- GitHub Full Gate 是交付门禁。
- 自动化渲染检查不是浏览器视觉验收；未取得实机截图，不声称已视觉验收。
