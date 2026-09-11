# 9月11日 PR03 预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: ede4bd06fb48c5aaeb0141fe35802cdc147781e2
working branch: feat/0911-pr03-quality-warehouse
task scope: 质检返工基础读取与仓库原收货页小入口
allowed files: 只读合同/查询/路由、质检看板、仓库入口、migration/manifest、测试/文档
forbidden files: 业务节点写权限、核价判责金额、原收货字段与默认落点、全局样式、生产数据
gate class: FULL

新增 rework:basic:view 仅授予 quality_control；数据库核验和独立白名单 SQL 不读取核价工资、责任审批、节点历史。照片只列返工原图/有效收货图片，沿用已存在的图片预览授权，不开放责任附件。质检兼有其他业务角色时保留原业务看板并可切换全量基础列表，原业务接口继续按原权限判断。Root 与原完整看板不变。

仓库原收货页左上小按钮直接进入现有订单回货；入口携带固定返回仓库路径，不新增动作授权、不变更默认落点与收货表单。

验证：前后端类型检查、ESLint、Web build、migration 静态校验通过；隔离 PostgreSQL 兼容引擎测试覆盖无关联订单、分页、仅有效图片、敏感字段白名单、无能力及伪造能力拒绝。全套本地测试通过。实际浏览器视觉检查受本轮环境禁止访问本地预览地址限制，待业务负责人验收。

Review 修复：已同步平台权限 Golden Source 的 PERM-ROLE-QC-001 与仓管入口规则，明确 9月11日批准的基础只读增量及敏感字段/写权限边界，避免旧“权限不拓展”表述与新授权冲突。本 PR 按要求仅一轮 Review，文档修复后由最终 Head 重新执行 Full Gate。
