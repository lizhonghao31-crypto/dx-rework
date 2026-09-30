# 返工纠偏第二 PR：历史原页面与流程间距

## 预检与范围

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: fe16f323afd99ccae4624e6ad586f7fae04c4e5b（#551 已通过）
- working branch: fix/rework-history-original-pages
- task scope: 历史节点复用原角色页面的只读模式；节点文字间距向外发收紧。
- allowed files: 返工历史读取服务及 reporting 契约、历史入口、原发起/分工/报数/最终数量复核/责任判定页面的只读参数、返工局部 CSS、相关测试与本记录。
- forbidden files: 外发与返工列表、共享样式、其他模块、数据库迁移、写服务、业务状态机、生产数据、部署配置。
- gate class: FULL

## 根因与修复

#549 历史页面把审计字段重新组装成通用输入框和表格，未使用原业务页面，因此缺失工人展开明细、丢失节点特有条件，并产生重复标题及未经格式化的小数。#551 的节点标题仍保留两行占位，网格还受旧规则等高约束。

历史入口改用原有 ReworkInitiationV2Form、ProcessWorkerAssignmentForm、WorkReportingForm、WholeOrderReviewPanel 和 ResponsibilityDeterminationPanel 的历史只读参数。历史模式不请求实时办理数据或操作权限，不开启提交/修改能力；图片、工序与工人明细展开、历史版本选择继续可用。页面上保留信息栏、图片、流程导航和返回当前节点。

历史读取在既有订单与节点权限校验后进行只读事务：按选定审计时间读取配置/预分配成员、任务、工人原始报数、有效数修订、驳回记录、整查、尾部确认、IE 预点数及审核、判责及老板签字。价格、数量、工资和倍率存储及计算未改；历史显示最多两位小数、去尾零。N06 使用原页面的 `reviewedPrice.changed` 条件，未发生调价时不显示价格复核。原始历史 API 的 fields/sections 继续保留兼容，页面不再把这些通用表格作为业务正文。

早期确实未保存的数据不会由当前数据补齐。持续办理的扣款入口仍返回当前业务入口，不以当前扣款事实冒充历史。

间距只改返工局部作用域，移除 `min-height: 3em`，覆盖旧的等高行轨道；保持九个节点及折行布局、图片和流程标题对齐。列表文件不在本 PR 中。

## 验证

- 原页面渲染测试：已提交分工人员、原控件布局、只读状态、流程导航；N06 无调价时无价格复核，有调价时遵循原条件且显示最多两位。
- 数据库用隔离 PGlite 与仓库迁移运行业务链路：历史八个提交节点、工人明细、提交版本、配置审核时间边界、禁止跨节点 entryId 和未授权读取。
- 原分工、整单复核、责任判定等定向回归及 web/api 类型检查。
- GitHub 当前 Head 的 Full Gate 与一次独立 Review 完成后交付。
- 没有真实浏览器截图/点击验收证据；不把 CI 通过称为视觉验收。部署由用户执行。
