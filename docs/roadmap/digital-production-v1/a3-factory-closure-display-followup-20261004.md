# A3 QC、返工原数量展示收口（2026-10-04）

## 范围及根因

基线 release/digital-production-v1 `636e29433906059113afc5026084e91582aa0ada`，分支 `fix/factory-flow-status-display`。仅修改两个页面展示，不修改 API、合同、数据库、数量、工资、状态流转或办理权限。按 AGENTS.md 低风险文案规则选择 QUICK；无需新增独立 Review。PR627、628保持原样，之后统一由用户安排部署复测。

QA 在第二次工艺发出后、第二次整款回仓前看到“大货质检 · 可办理”，但输入与保存正确禁用。标题仅使用持久任务 `ready`；实际表单同时使用 `sheet.inTransit`。仅当 QC 任务 ready 且在途时，标题改为“等待整款工艺回仓”。其它任务及 pending、blocked、completed、cancelled 标题保持原样，原 fieldset 禁用表达式没有变化。

P14 的“返工 待填写 件”来自原返工单可空字段 `rework_quantity`。新版办理可能没有此旧字段，空值本身不构成未完成业务。空值改为“原单未记录返工数量”，已有值（包括 0）仍显示真实数量。没有用最终工序数量填充旧字段，没有把原数量字段变为必填，也没有改变未清事项、质量问题、工资关联或本期装箱状态。

## 验证证据

- 实际 App + Chromium，全部 API 为隔离只读模拟数据；脚本禁止业务写入：`scripts/acceptance/factory-closure-display-regression.mjs`。
- 覆盖首次回仓前 pending、首次回仓 ready、二次发出 ready、部分回仓沟通、整款回仓、部分 PO 检查、旧检查历史、blocked/completed/cancelled、非 QC 只读权限。
- 现有模型只有整款“工艺回仓”事件；部分回仓用“工艺沟通”记录，其本身不解除在途限制。测试没有虚构按 PO 回仓规则。
- 返工原数量 null / 0 / 3，原单已完成、原工资关联 2 条、没有未清事项、“本期装箱完成”、出柜及客户签收仍未知。
- 本地 PostgreSQL 服务端 13.23、隔离 DB `dx_pg13_full_test`：原 `sourcing-pr03-postgres.test.ts` 中 P13/P14 whole-order 两个场景通过（2 passed，54 非定向用例 skipped），覆盖无工艺与印花链路、二次往返/复检、原收货装箱和结案事实。日志 `/tmp/dx-factory-status-pg13.log`。不是线上数据验证。
- 浏览器命令：`DIGITAL_QUERY_TEST_URL=http://127.0.0.1:3207 CHROMIUM_PATH=/usr/bin/chromium node scripts/acceptance/factory-closure-display-regression.mjs`。

## 图像证据与验收边界

新截图 Library `libfile_6cd78883dbac81918029e5f5b88b93fe`（print-qc-before-return-disabled.jpg）经当前官方消费者 materialization 流程返回 `library file transfer failed: download failed`，未取得图片字节，未查看原图，未猜测或重试签名 URL。本次定位依据 QA 给出的时间、路由、表现和代码，并以本地实际页面验证。

未合并、未部署、不操作线上 DB。不能把本地测试称为 Acceptance 已通过。此前 QA 已完成正常和独立特殊结案两条路线；工资合计 69 无重复计数。出柜与客户签收仍未知，不纳入通过结论。
