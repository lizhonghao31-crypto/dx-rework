# 返工 PostgreSQL 原七项夹具恢复

## 基线与边界

- 仓库 `lizhonghao31-crypto/dx-rework`；目标 `release/digital-production-v1`。
- 远端真实基线 `2aa4a8d9bb6fd91c8a336ec15b83344291b9f0fd`。
- 仅修 `tests/integration/rework-postgres.test.ts` 的初始化、合法输入及一条有规范依据的过时预期，并让映射 Gate 使用现有 business-chain 配置。
- `[FULL]`：涉及 Actions 映射以及审计、幂等、删除边界的数据库回归；不把它伪装为无数据库 QUICK。
- 不改业务服务、接口、SQL 迁移、manifest/checksum、权限、trigger、阈值、线上数据或部署。后续流程治理不在本 PR。

## 失效原因与恢复入口

原 `beforeAll` 手选十个旧迁移，缺少 0044 的订单字段、0086 的收货表和后续依赖。旧基线 `21aa4de4` 与本基线在 PG13.23/16.15 都先于主要断言失败。

现在先执行既有 `assertTestDatabaseTarget()`，再创建 `ownedPostgresSchema()` 记录的自有随机 schema。把同一 schema 放进连接 URL 的 `options`，调用正式 `applyMigrations()`；它读取并校验当前完整目录/manifest，按真实服务器版本使用原执行兼容规则。断言全部 278 个版本/checksum 与当前 manifest 一致，重复调用不新增迁移。

测试身份显式启用；提交输入补齐现行订单数量、整查承担方及报告；补图使用原品控角色已有的 `tools:user` capability，不新增角色或数据库权限。原旧服务入口仍只是内部契约测试，不开放独立创建 UI/路由。

清理只处理本套件成功创建的 schema。安全预检失败时不连接目标做清理；初始化后失败也会清理自有 schema，最后确认其不存在。

## 唯一预期纠正的规范依据

[ADR-0004:54](../architecture/decisions/ADR-0004-rework-initiation.md) 明确：已提交或已取消单据保留附件归属，不能绕过撤回流程替换证据。

原提交 `b0992a0d16766b6ef59497246c0de2f401b10049` 的保号用例没有附件，故原 `attachmentIds=[]` 正确。`2553611c0a70cd518f7b7293178c8398fd820d9f` 为满足 [ADR-0018](../architecture/decisions/ADR-0018-n01-evidence-and-wage-integrity.md) 的 N01 图片必填规则加入 `withdrawal.webp`，并把该 ID 传入草稿，却未同步空数组预期。

本次按已核准口径改为 `[attachmentId]`，并验证数据库仍绑定原 `rework_order`/原单 ID、附件仍 ready，以及取消审计 before/after 均保留该 ID。其余保号、状态、禁止补图/恢复和精确事件序列预期不变，不通过删除证据迎合旧断言。

## 原七项的实际目标

| 原测试 | 本次必须到达的断言 |
|---|---|
| reuses one idempotent draft and rejects changed semantics | 同 key 同一单/单行、改语义冲突 |
| atomically binds ready QC evidence, submits once and warns without merging same styles | 附件绑定、提交重放、单次 outbox、补图限制、同款不合并及直接 SQL 不可变性 |
| keeps one number through withdrawal, correction, resubmission and cancellation | 保号、重提、取消保留附件、取消后补图/恢复拒绝及原六事件顺序 |
| rejects N01 submission without a ready image even when all other order facts are present | 其它资料有效时由图片规则拒绝 |
| allows only root to logically delete once while retaining immutable order evidence | 普通角色拒绝、Root 幂等、已删不可读/不可篡改及删除审计 |
| rejects stale versions, foreign drafts and foreign or pending attachments | 旧版本、外人及未就绪附件拒绝 |
| rejects a trusted-looking audit event when its complete business snapshot differs | 完整可信形态快照仍不能授权不匹配字段；同事件匹配写入正对照成功，随后整事务回滚 |

末项用原真实创建审计补齐完整字段，避免缺少后续字段提前拒绝而产生假阳性。保留原 SQLSTATE 55000 断言；SAVEPOINT 后匹配正对照成功，再回滚整事务，确认版本未变、试验事件不存在。

## 已完成的本地验证

- Node22.22.2/npm10.9.9，现有标记隔离库，测试角色无集群特权。
- PG13.23：最终原 7 项全部通过；PG16.15：同样 7 项通过。无条件跳过。
- 现有 `vitest.business-chain.config.ts`，没有修改其 60 秒配置或用例阈值。
- 故意错误的外部 manifest 被正式校验拒绝，七项不运行；已创建 schema 清理并独立只读确认不存在。
- 非 test 的 NODE_ENV 被原安全守卫拒绝；这两次是预期拒绝证据，不计入七项通过。
- 映射 Gate 实际 shell 的 27 项单测通过，确认本套件使用既有配置、后继普通套件恢复默认，拒绝/失败/全跳过仍失败关闭。
- Actions policy、定向 lint、工作区类型检查通过；共享包构建通过。未重复无关整套本地测试。

本地命令（URL 必须是已标记隔离测试库，不在此记录凭证）：

```sh
NODE_ENV=test node scripts/test-database-safety.mjs
NODE_ENV=test node_modules/.bin/vitest run --config vitest.business-chain.config.ts tests/integration/rework-postgres.test.ts
node_modules/.bin/vitest run tests/unit/full-gate-risk-map.test.ts
node scripts/ci/verify-actions-policy.mjs
```

CI 和 Review 证据以 PR 上最终实际 Head 为准；本地通过不代表远端门禁或现场 Acceptance 已通过。没有更新 Acceptance、操作 ECS、改真实订单或执行现场 seed。
