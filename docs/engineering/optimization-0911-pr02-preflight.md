# 9月11日 PR02 预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: f31e597c9b88b28e61834351acea9dc4d294c5bb
working branch: feat/0911-pr02-todo-search-return
task scope: 待办真实跟单搜索及返回条件
allowed files: todo服务/合同、生产待办姓名投影、待办页面及任务返回入口、定向测试/文档
forbidden files: 待办分配、金额、全局样式、原业务操作、生产数据
gate class: FULL

返工用rework_orders.merchandiser_user_id。外发当前唯一订单跟单关系就是sourcing_cases.created_by：现有跟单建单、合同补充、派单及生产预警均沿用该责任人；复用现有外发列表跟单搜索对应的app_users关联，不将返工创建人或待办接收人当跟单。实时生产从其来源外发单沿同一关系读姓名。样衣不增加跟单。

返回路径仅允许站内/ui/my-tasks，搜索通过replaceState更新，不新增每字历史；按当前账号绑定历史状态，切换账号清空旧条件。后端沿用最后有效页钳位。

验证：合同构建、API/Web 类型检查、ESLint、Web 构建通过；待办筛选与分页/返回 25 项定向测试通过，补充更新跟单搜索提示断言后通过。

Review P2：待办挂载及 bfcache pageshow 恢复时强制重新校验 auth/me，禁用身份 HTTP 缓存并隔离旧异步结果。恢复期间停止旧待办查询；身份变化或会话失效时加载无旧查询参数的待办页，连同旧页面壳身份一起丢弃。相同身份保留条件并刷新。
