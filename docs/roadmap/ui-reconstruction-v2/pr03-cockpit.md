# PR03 生产管理座舱

正文依据：V2.0 §6.1、§9.3。图1仅作布局参考，使用七大流程及原业务数据。

基线：main b7d400e623da6381302bf70509ee7fe81b6ac3e8；集成 release/digital-production-v1 842f43b8c0b588be6a96508a349db7ebc1019339；开工时无开放PR。不合并main。Gate FULL。

施工期间release合入已批准的PR645，最终顺接3684699fb8fa9e8e317f26ec2d65a2603dfeee7a，保留238条迁移及双0222身份；本PR不修改该兼容修复。一次Codex Review的分页与外发历史返回P2已集中修复，另修正尚无开发单时误带不存在轮次的链接。最终HEAD的Gate/视觉回归另行记录，不把初次Review SHA当最终HEAD。

| 正文区域 | 正式消费者 / 数据与行为 |
|---|---|
| 正式入口 | /ui/digital-cockpit → DigitalCockpitPage → DigitalJourneyCockpit，保持单个原Shell |
| 六个KPI | 公共KpiCard按钮；Journey summary与当前组合筛选同源，点击重置页码并查询对应KPI |
| 常驻与更多筛选 | 公共FilterBar；客户/主第二跟单/品类选项由授权Journey事实生成；大/小流程、状态、风险、创建日期使用原查询契约 |
| 订单列表 | 公共BusinessTable/Pagination；一个档案一行，命中原因定位具体节点，不将节点完成当整单完成 |
| 七流程与小流程 | 公共FlowStageCard/NodeTable；所有阶段常驻；并行在办节点同时显示；历史轮次可选，沿用显示原轮次 |
| 时间与风险 | 原计划保持日期精度；原SLA不变；核实/未核实/未知完成事实区别显示；风险按钮展开并定位精确节点 |
| 相关单据与操作记录 | 公共DocumentList/ActivityLog左右并列；原节点进入、完成、改派事实，不用示例日志；精确原URL/版本/轮次/事件保留 |
| 返回上下文 | 共享壳仅在验证过的本地座舱returnTo存在时显示返回入口；原数字面板关闭支持返回座舱；恢复筛选/分页/选单/展开/焦点/轮次并重新读取 |

公共组件及原tokens来自packages/ui/src/production；原表单、服务、状态机、计薪、权限、迁移、部署工具冻结。沿用新数字流程连续自然时间与旧领域既有工作日算法，不全局改写计时。

定向单元与原PostgreSQL Journey测试覆盖返回契约/日期精度/未知时效/整单完成/并行展示、授权筛选选项和原任务保留。scripts/acceptance/v2-pr03-real-browser.mjs只接受本地拥有的TEST数据库，以原API补订购资料并建立21个草稿进行分页；不拦截API响应。桌面实页检查KPI、正向组合筛选、物料原UI与双返回、分页、空态、404、技术角色拒绝和原只读历史返回适配。

最终SHA截图、FULL及一次Codex Review以交付证据为准。原生返工返回适配使用独立原TEST历史，不宣称已收到货的数字整链UI全部执行。移动专项按用户决定暂缓；完整角色接力UAT与线上Acceptance未跑。

已知未完成：其它未启动节点独立计划登记规则；A4板房同母单技术读取可见其它任务元数据；仓库todo:view/我的待办入口缺失。本PR不改变这些结论。PR04在本阶段连续施工；PR05–07未授权。
