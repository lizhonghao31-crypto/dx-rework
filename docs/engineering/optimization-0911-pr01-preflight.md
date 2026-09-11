# 9月11日 PR01 预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: d620f0503cdb10bfdecf3715ff7912792029d94d
working branch: feat/0911-pr01-wage-settlement
task scope: 工资结算标记、交叉筛选及有限月结清理
allowed files: reporting、wages、reporting合同、能力文案、0171迁移和manifest、对应测试/需求记录
forbidden files: 全局UI、其他业务状态机、已有迁移、真实工资及订单数据
gate class: FULL

以当前main为代码基准；共享源码已核对Git blob一致。前端保留原工资布局，服务端一份筛选SQL联动查询/汇总/导出/标记。主要风险是500行范围截断与权限泄露，定向验证聚焦完整范围、同名不同ID、日期边界和允许/拒绝。

定向验证：隔离SQL 3个场景通过（502条范围、两个人员ID、完工日边界、历史月结仍未结算、预览后新增明细、重复请求、允许/拒绝）；相关既有9项测试通过；前后端类型检查通过。新增SQL测试挂入迁移门禁已有Root回归入口，由Full Gate再次使用原生PostgreSQL执行。
