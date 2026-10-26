# Acceptance 首轮补正误拦截修复

基线：`release/digital-production-v1` @ `9b0a899f748870807fe7c4277568ea30f581dd7f`。
分支：`fix/development-amendment-readiness-20261026`；Gate：FULL。
只处理同轮补正的下游执行判定，独立于时钟修复及 P09/P10。

## 根因与修复边界

发布自动生成 `development_shipping`，其底层任务已经 ready 且 entered_at 非空；这仅表示可登记寄样，不能证明已经制作或实际寄出。原补正提交把任意非核料任务 entered_at 当成下游办理，因而误拒绝第一次核料退回后的设计师补正。

仅排除寄样任务自动进入可办这一条假阳性。其他制作任务 entered_at、所有下游 completed 状态，以及下游原生 route_facts 都继续阻止覆盖制作依据。原资料权限、文员核配、真实执行段及工资规则不改；不重置原进入时间、deadline revision 或冻结标准。不改迁移与 checksum。

## 回归与证据

- 本地隔离 PostgreSQL 16、完整当前 schema、原生发布/核料退回/补正服务；新增反例在未修基线真实复现“后续工序已进入办理”拒绝。
- `development-amendment-postgres.test.ts`：25/25 通过。新增寄样仅自动 ready 时的保存/提交/幂等重试及原时钟、截止历史、冻结计划逐项保留；实际寄样后拒绝且保留草稿/正式资料；既有纸样启动后拒绝、权限拒绝、并发和文员复核测试继续通过。
- `development-amendment-contract.test.ts`：7/7 通过。
- API typecheck、改动文件 ESLint、diff 检查、工作树 secret scan 通过。
- GitHub Full Gate 必须单独核最终 Head；本记录不把本地结果当成线上补验。

## 现场及未混入边界

现场 A：source `922b1e87-4965-42b6-9f0f-529097ad1a02`，补正 task `c293c962-b90a-4805-b207-f9197d89c41c`，草稿 1 原样保留。未连接或修改现场；部署并经父线程核验后再沿原草稿/任务重试，不复制或重置原记录。

老板单次审批响应结果未确认，不重发、不推定契约缺陷。标准 UAT 种子缺 cutting_worker 是测试前置，不新增账号、不授角色或全局权限。本任务不 ECS、不部署、不合并、不发 Codex Review。
