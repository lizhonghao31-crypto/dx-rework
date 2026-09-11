# 9月11日 PR04 预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: f89aa43cd035b7bd57f4139a3c24340f93bc9ebe
working branch: feat/0911-pr04-finance-node-read
task scope: 财务总监按节点读取真实业务数据及关联附件
allowed files: 节点只读查询/合同/路由、详情只读面板、migration/manifest、测试/文档
forbidden files: 节点提交、核价、判责、审批状态机与授权、Root 既有行为、生产数据
gate class: FULL

新增独立 rework:finance_nodes:read 能力，仅授予财务总监。真实数据库权限核验后，在只读事务内读取白名单业务字段，涵盖工序各版本与 IE 核价、分工报工、尾部最终数量与 IE 复核、数量调整、责任金额和签字、扣款及工资。已完成节点读历史记录；未开始仍沿用原未开始展示。

只读展示无写入按钮；原角色在当前节点已有的业务工作区仍保留，财务总监原扣款异常特批也保留。附件沿用已有 business-detail 关联和下载鉴权，不创建公开下载绕过。

验证：本地合同构建、API/Web 类型检查、ESLint、Web build 与 migration 静态校验通过；全套本地 1418 项通过。隔离完整业务链验证所有 12 个节点读取真实记录、已驳回签字历史、工资/扣款内容、附件授权及拒绝越权；读取前后订单版本/状态/工资保持一致。实际浏览器视觉检查受环境禁止本地预览连接限制，待验收。

权限总文档已同步财务总监节点读取与读写分离规则，并补齐本轮已批准的工资已发放标记例外；不扩展导出、付款或其他角色授权。当前节点只读预览使用实际状态，避免沿用未开始提示。
