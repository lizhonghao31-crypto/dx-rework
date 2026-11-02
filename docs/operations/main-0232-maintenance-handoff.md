# 0232 PMC 维护计划与隔离验证

本次修复的基线为 main `3c12c6d3aa532d6b7783144d3bca49d47966483a`，工作分支为
`fix/pmc-maintenance-plan-0232-20261102`。目标是补齐已发布 0232 的维护计划，
验证真实升级和失败恢复，并修正旧演练的候选边界；不修改迁移 SQL、checksum、
员工角色或线上数据。风险等级为 FULL。

## 准入和部署边界

`scripts/deploy/main-maintenance-plans.json` 的 0232 项按原 SQL 校验三张权限表
owner、attachments TRIGGER、八个旧函数 owner、public USAGE/CREATE 和 sql/plpgsql
USAGE。新建函数 `guard_pmc_attachment_upload()` 不属于必须已存在的 owner 检查。
缺计划或权限不足仍在停服和切流前拒绝；在线工具仍拒绝 schema 变化。

应用候选 SHA、已安装维护工具 SHA 及其所载计划、真实数据库 ledger 是三个独立
事实。应用源码包含新计划不代表已安装工具已更新。本次未读取生产 ledger 或
installed tool，不能据本地验证或 CI 通过承诺现场可以直接更新。
安装和冻结候选继续使用既有 [main 维护说明](main-0223-maintenance-handoff.md)，
不能用旧的 0227 专用更新脚本代替本次现场状态核验，也不能跳过在线 DDL 拒绝保护。

## 测试入口和资源

- `tests/unit/main-maintenance-plan.test.ts` 从既有维护支持起点 0222 自动核对当前
  manifest 每项的唯一精确计划，另测 0232 权限和缺计划、指纹漂移拒绝。
- 两份原 PG13 演练分别固定真实前缀和截止 0223/0227 的候选，避免将未来迁移混入
  历史演练。它们仍要求各自新鲜、带标记的 PG13 库，不能以 PG16 结果替代。
- `tests/integration/main-0232-maintenance-postgres.test.ts` 进入 canonical PostgreSQL
  plan，在现有串行 correctness 配置中运行。它使用单独的
  `dx_rework_main_0232_test`，不借用默认业务库或 acceptance-clock 库。
- 显式输入为 `MAIN_0232_TEST_DATABASE_URL`、同库本机
  `MAIN_0232_TEST_ADMIN_DATABASE_URL` 和 `MAIN_0232_EXPECTED_PG_MAJOR=13|16`。
  低权限角色必须通过原 `assertTestDatabaseTarget`；admin 只用于该测试的权限、
  故障设置及精确资源清理，不执行迁移或员工业务写入。
- 父 runner 注册并核验专库身份；演练在任何迁移前认领存在且为空的 public。
  所有 worker 退出后，父 runner 按精确 manifest 删除该 public 并验证不存在。
  库身份保留用于同一执行收据复验，该库不可再次充当新鲜演练库。失败或中断未
  完成清理时保留资源清单，不签通过收据。

0232 演练使用真实 SQL 和原 Bash 维护控制器；nginx、应用启动、备份等运行探针为
本地桩。它验证原 231 条迁移收据及时间、非空员工身份/角色历史、固定 PMC 能力、
旧 guard 恢复启用、事务失败全回滚、提交后启动失败保持维护及同候选重试零应用。
这不是 ECS、PM2、生产备份或现场 HTTP 验收。PG13 与 PG16 结果单独记录；CI 的
专库沿用现有 PG16 实例，不调整 worker、锁容量或 Gate 超时。

本次实际检查记录写入 `docs/engineering/construction-evidence.json`；审核、最终
Gate、合并与部署状态分别报告。合并此修复不执行任何现场升级。
