# PR01 公共壳与导航

> 首次 PR 的历史记录。641/642 合并后首阶段补齐以 [stage01-repair-acceptance.md](stage01-repair-acceptance.md) 和 [golden-region-contracts.md](golden-region-contracts.md) 为当前范围及验收契约：正式数字页已实际消费公共画布/标题，座舱与沙盘消费公共筛选、KPI、表格、分页；板房二级顺序和原生产填报二级入口已修正。下面原验证结果不能替代补丁最终 Head 证据。

本阶段授权仅 PR01–02，draft PR，不合并、不部署；首页暂缓。材料为用户上传《达兴数字生产平台_系统重构与UI重构施工计划_V2.0_20261004.docx》，全文及五张内嵌图已读。用户最新决定：正文是内容依据，图片仅是视觉参考。图中九阶段、交货完成、串行技术准备、示例人员/数量/日期均不得复制到业务规则。

## 一次预检

- repository: lizhonghao31-crypto/dx-rework
- production reference: main@b7d400e623da6381302bf70509ee7fe81b6ac3e8
- integration base: release/digital-production-v1@5f91af8f2169e85d194e23b65ec3a4409f31f513
- working branch: feat/v2-pr01-shell
- gate: FULL
- allowed: Shell/导航、数字页面重复公共区域、共享 UI、路由上下文适配、测试及证据。
- forbidden: 旧模块内部组件、API、权限/状态机/字段/按钮/默认筛选、迁移、线上操作、PR03–07。

release 包含现有数字业务及两条历史的迁移兼容处理；main 与 release 各有独立提交，不做盲合，不改既有迁移。当前开放 PR 查询为空。基线部署状态沿用交接，未执行线上探测。

## 页面契约与分期

全部页面共用 217px 深色导航、DX 品牌、蓝色激活态、可滚动二级导航。综合入口依次待办、座舱、实时生产、回货；主流程依次设计师创建、产品开发打板、产前、外发、开裁、裁后工艺与发厂、返工；支撑保留原入口。菜单按原授权显示，不授予权限。订单回货保留内部 active key 和原 URL，显示名称为订单回货看板。

PR01 的数字入口接入当前正式页面：设计师 → digital-production；板房 → cockpit/development；产前、裁后 → cockpit/bulk。workspace 参数选择导航上下文，stage 参数初始化原列表。这里是原功能挂壳，专属工作台内容由 PR04/05 实施；不把当前座舱内容称为最终页面。原办理的 development/bulk/factory/instruction/closure 等参数和旧路由继续有效。

五张参考图保存在 golden/reference-1…5.png（1672×941）。区域契约：图1订单摘要/七阶段/节点/风险/单据与日志，PR03实现；图2两开发入口/筛选/列表/原开发资料，PR04；图3环节统计/任务列/风险/选中详情，PR04；图4摘要/真实前置/并行技术准备/完整开裁门禁/风险，PR05；图5生产筛选/原事实列表/选中记录/异常，PR05。共用壳由本 PR提供，图中内容不作业务默认值。

共享 UI 从 @dx-rework/ui/production 导出，样式仅 dx-production-ui 作用域：PageHeader、KpiCard、FilterBar、BusinessTable/NodeTable（复用原表格）、StatusBadge（原组件）、RiskPanel、FlowStageCard、DocumentList、ActivityLog、Pagination。Shell/Navigation 复用现有正式组件。数据、未知/拒绝/空态由调用页的真实服务决定，组件不推导业务状态或数量。后续页面组合这些组件，不引入组件库。

旧页面 main 容器及内部布局保留；仅统一 aside。新页面取消重复顶部首页/待办/身份和座舱问候身份；身份保留在公共导航尾部。移动端底部导航与更多抽屉沿用。

## 证据边界

本地浏览器结构/路由/角色夹具与固定视口截图不替代 Acceptance。用户负责部署，故 Acceptance 同 SHA 真后端角色接力、旧业务操作前后截图和视觉验收仍待用户部署候选后执行。已知 A4 的同母单任务元数据可见与仓库 todo:view 缺失未在 PR01修复，不宣称 UAT 通过。

本地结果：Node 22.22.2/npm 10.9.9；lint/typecheck/workspace build、Actions policy、迁移静态检查、历史 secret scan 和 production audit 通过（0漏洞）。全量无 DB 测试1980通过、413跳过；定向导航13通过。浏览器 Root/工人菜单允许与拒绝、query变更大货初始化、390px抽屉通过；9个成熟页面同夹具空态/失败态主内容文本与基线一致。旧模块内部源文件无 diff；未执行真实写操作。测试入口 scripts/acceptance/v2-shell-regression.mjs；截图与结果保存本地按最终HEAD标识，不作 Acceptance 通过声明。
