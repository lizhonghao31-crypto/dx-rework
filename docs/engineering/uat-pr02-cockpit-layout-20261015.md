# UAT PR02：恢复座舱确认稿布局

- 仓库：lizhonghao31-crypto/dx-rework；目标：release/digital-production-v1。
- 起点：PR01 Head c917f544aeefefabdc8bff787c5735127b00f8f8；分支 fix/uat-pr02-cockpit-layout。
- 范围：digital-journey-cockpit.tsx、digital-journey-cockpit.css 与本说明；QUICK。
- 依据：本轮 UAT PR 施工计划 PR02；仓库 golden/reference-1.png 及 golden-region-contracts.md 的确认布局。

8ebfb4aa 将原全宽流程带移入图片右侧窄栏，并将当前节点、节点表及单据/活动重新排列。本次只撤销该排列与对应 UI10 CSS 覆盖：款图回到摘要，七流程恢复全宽；当前节点/节点表在左，进度/单据在中，风险/活动在右。后续新增的产前条件继续在主面板下展示。原 PO 事实、双交期、完成时间/结果、并行任务、精确下钻与返回保持当前实现；没有恢复历史已移除的订单指标或业务页签。

局部验证：Web 类型检查、9 项现有座舱单元测试、定向 ESLint、Web 构建通过。实际 App 的合成 API 浏览器检查覆盖 Root/板房工人、1672/1280/390 宽度，共 6 个场景：七阶段、桌面区域对齐、流程时间收起、产前事实保留。人工查看桌面和手机截图，并检查长时间文本不越出流程卡；另外 10 个既有页面正文与 PR01 基线一致。模拟读取只验证 UI，不声称验证真实后端权限或线上 Acceptance。当前 Head 的 Quick Gate 在 PR 后独立记录。

未修改查询、服务端权限、状态机、指标口径、共享 UI 组件或生产数据；不执行部署。
