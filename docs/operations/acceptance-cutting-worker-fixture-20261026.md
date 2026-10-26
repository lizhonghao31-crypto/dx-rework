# Acceptance 独立裁床身份维护入口

本次用户批准新增一个仅 Acceptance 使用的独立裁床测试身份。使用 `scripts/acceptance/check-cutting-worker.ts`，不要为此运行全量 `seed-role-users.ts`：全量入口会刷新旧用户、身份和部分业务人员记录。本入口不修改 API、角色定义、权限守卫、migration 或 P09/P10。

## 固定目标和写入范围

| 项目 | 唯一允许值 |
| --- | --- |
| alias | `cutting-worker` |
| display_name | `[UAT] 裁床师傅` |
| provider / provider_user_id | `dingtalk` / `uat-cutting-worker` |
| union_id | `uat-union-cutting-worker` |
| corp_id | 已初始化 Acceptance Root 及安全策略绑定的测试 corp |
| 有效角色 | 仅原有 `cutting_worker` |

首次 apply 必须显式固定一个尚未占用的 app_user UUID。事务只创建这个 app_user、一个双 UAT 标识的 identity_mapping、一个原裁床角色 assignment，以及创建/授角色审计事件。若固定身份已经存在且完全标准，仅补缺失的裁床角色；若已经完整，再次 apply 零写入，包括时间字段和审计。不同 UUID 不得复用或重绑定已有账号。

原 `BulkPreparationService.dispatch` / `validAssignee` 以在职有效 app_user 和原 `cutting_worker` 角色校验裁床主办，不要求 business_people。本入口不创建或修改 business_people、别名、employee_directory_profiles、凭证或会话，也不调用人员修复、组织策略初始化、Root bootstrap 或自动启用逻辑。旧标准身份和角色目录不变；仅抽出原名单供两个入口共用只读预检，未把新裁床身份加入全量 seed 名单。

## 执行前置与拒绝规则

- 必须 `NODE_ENV=test`、`ACCEPTANCE_LAB_ENABLED=true`、`ROOT_DINGTALK_USER_ID=uat-root`，显式配置 `DINGTALK_CORP_ID` 与 `ACCEPTANCE_DATABASE_URL`；不回退 DATABASE_URL。
- 沿用原 Acceptance 数据库 URL/实际连接库名检查，且两者必须一致；沿用外部副作用关闭、现有 Root bootstrap/owner 角色和 corp 检查。还要求 Root 在职启用、双 UAT 标识正确和原裁床角色启用。没有初始化或异常 Root 时停止，不修复。
- 对原名单每个已存在非 Root 身份保留原额外角色、未撤销 delegation 拒绝。此预检全为 SELECT，不刷新旧身份。
- 新身份的 provider/union/corp、启用/在职状态、显示名、UUID、额外绑定异常时停止；额外有效角色、直接 capability、未撤销入向/出向 delegation 或意外业务人员档案也停止。保留异常资料，不自动撤销、覆盖或修复。
- 不接受任意 alias、role 或其它维护参数。apply 必须 `--expected-user-id=UUID`；默认/check 使用数据库只读事务，并在连接 options 最后强制 `default_transaction_read_only=on`。

apply 在一个事务内使用固定目标 advisory lock，再按原 AccessMasterDataService 的事务内角色写入协议获取角色锁、设置审计事件/request ID 并插入。原 DB authority、角色创建/lifecycle 和审计触发器全部保留。公开 assignRole 自行管理事务，因此本入口沿用其事务内协议，避免创建身份后再授角色失败留下半成品。失败整体 rollback；重试重新预检；并发只有一次创建和一次授角色。

## 用户执行方式

此文档不是现场执行回执。现场操作由用户执行，施工代理不连接 ECS、不执行现场 seed 或授权限。父线程核验独立 fixture PR 和精确 Head Gate 后，提供附带完整 commit SHA、固定新 UUID 的命令；不要从浮动分支执行。

使用与运行应用分离的固定版本工具目录，按仓库锁文件准备好的 Node 22/npm 10 依赖及共享包，不切换正在验收的应用目录。通过既有安全方式提供上述 Acceptance 环境变量，不把 URL、密码、控制码或 token 复制到聊天/日志/PR。无需新建凭证或修改生产配置，也无需在 ECS 上重跑 Gate。

在已核版本目录先运行：

```sh
npx --no-install tsx scripts/acceptance/check-cutting-worker.ts --check --expected-user-id=<固定新UUID>
```

确认只读结果为 `missing`（首次）或匹配固定 UUID 的 `missing_role`/`ready` 后，才由用户运行同一版本同一 UUID 的 `--apply`，再以同样参数 `--check` 确认。发生拒绝时停止并报告，不运行全量 seed 或改用其它身份绕过。

## 隔离回归证据

本地 Node 22.22.2 / npm 10.9.9、PostgreSQL 16.15、完整原 migration 和全部原触发器。只创建每例独占测试 schema，结束删除该测试 schema；没有现场/真实数据操作。

`acceptance-cutting-worker-postgres.test.ts` 共 15 项通过：

1. 默认只读零写入、三请求并发首次创建唯一身份/唯一角色、两类原审计事件、幂等重复整库快照不变，以及所有旧身份/人员记录逐字段不变。
2. 已有完全标准但缺角色的固定身份只补角色，不刷新用户或身份字段。
3–9. 旧目标禁用、union 冲突、corp 冲突、provider alias 冲突、直接 capability、额外角色、意外业务人员记录分别拒绝且全表不变。
10. UUID 已占用/不同固定 UUID、生产配置和 corp 冲突拒绝且无写入。
11. Root 的 UAT union 标识错误拒绝，不修复。
12. 原标准身份出现额外角色时，新身份尚未创建即拒绝。
13. 目标存在未来生效但未撤销 delegation 时拒绝。
14. 配置为 Acceptance 而实际连接非 Acceptance 的本地数据库时拒绝。
15. 测试专用失败触发器让原角色写入失败，证明用户、映射、审计整体回滚；移除该测试故障后同一 UUID 重试成功。

快照逐字段比较 app_users、identity_mappings、user_role_assignments、user_capabilities、delegated_authorizations、business_people、business_person_aliases、employee_directory_profiles、access_security_policy、owner_bootstrap_consumptions、business_roles、role_capabilities、auth_sessions、operation_events。旧板房师傅已有人员和别名、旧设计师已手动禁用，均保持原值。

4 个新配置单元测试与原 authorization-guard / seed-ordering / worker-people 单元测试合计 17 项通过；修改文件 ESLint 与脚本严格 TypeScript 检查通过。原 preflight 在同一个 pg client 上 Promise.all 查询会产生已有 pg 弃用提示；未改变预检语义或升级依赖。Full Gate 需以此独立 PR 最终 Head 结果为准；本地通过不等于现场账号已创建或后半业务链已验收。
