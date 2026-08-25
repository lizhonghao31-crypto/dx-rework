# 1.0 移动端与图片可见性一致性预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: f792f921f33cab100b21b91b0ef440680ae9fd82
working branch: fix/v1-mobile-image-consistency
task scope: 统一标准角色的电脑/移动导航排版，修正工人任务信息层级，并让所有已获系统准入的角色查看返工全流程图片。
allowed files: apps/api/src/rework/rework-business-detail-service.ts; apps/web/src/frontline-task-page.tsx; apps/web/src/frontline-task-page.css; apps/web/src/styles.css; apps/web/src/shell-navigation.css; tests/unit/v1-prelaunch-frontline-minimal.test.ts; tests/unit/order-detail-information-architecture.test.ts; tests/unit/mobile-shell-navigation.test.ts; tests/integration/rework-business-detail-access-postgres.test.ts; docs/engineering/v1-mobile-image-consistency-preflight.md
forbidden files: 业务状态机、工资金额计算、责任判定、角色写入迁移、root 权限绕过、ERP、ECS、钉钉应用配置与生产数据

## 业务规则变更

- PC 与移动端使用同一权限生成同一模块集合；仅导航呈现不同。
- 工人任务主信息只显示款号，RW 返工单号置于次级位置，不展示“订单号未填写”。
- 所有已获系统准入、具有生效业务角色的账号均可读取返工单详情中的全流程图片及其预览下载授权。
- 未分配业务角色、被停用账号和未认证请求仍然拒绝访问。
- 不改变图片上传、删除、补图、OSS 私有桶及审计规则。
