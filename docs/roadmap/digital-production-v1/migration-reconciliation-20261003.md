# A3 与生产 main 迁移历史兼容

## 本次范围

- repository: `lizhonghao31-crypto/dx-rework`
- target: `release/digital-production-v1@da6590cc756f7f79a6ebd0ce1c7af39a30f86fff`
- production-code reference: `main@99db52391cbb4575950eb20b5fc04b7782b061d8`
- working branch: `fix/a3-main-migration-reconciliation`
- gate: FULL
- allowed: main 的合同功能接入、迁移历史兼容、部署前校验、对应测试及文档。
- forbidden: 部署、服务重启、线上迁移、改写已应用迁移记录、真实订单操作。

## 问题与处理

两分支共享 0001—0217，但 main 的 0218—0220 是合同模板刷新、Root 合同内容编辑、合同展示同步；数字分支同编号用于身份、权限和待办。旧升级器严格要求单线历史前缀，因此 main 历史在第 218 项被拒绝。A3 PR 的 Full Gate 只证明集成分支基线升级，不代表生产历史可升级。

本次保留全部旧 SQL 文件名、内容和 checksum，合并两分支迁移目录与清单。0218—0220 的重复数字前缀仅允许冻结清单中那三对具体版本和 checksum；其它重复、缺号、未知记录、checksum 漂移仍拒绝。完整迁移标识仍唯一。

历史校验要求共享 217 项完整，并分别验证合同三项与数字十四项的连续前缀。只有两条历史都完整后才允许 0232 及后续迁移。允许部分升级后重试，但不能跳过任一分支中间项。不会删除、重命名或改写 schema_migrations，也不会假记已执行。旧记录的 applied_at 不变。

新增 `0232_reconcile_contract_and_digital_histories` 检查两套 schema 已存在并形成统一版本。统一目录共 235 项（0001—0232，加三项已知分支碰号）。独立版本确保已经到 0231 的 Acceptance 也会触发部署流程原有备份和迁移步骤。

同时接入 main #596/#598/#599 的合同代码、权限、页面与回归：模板/供应商刷新、Root 财务核对前修改合同、合同信息展示同步。保留 A3 当前主跟单权限、制单、开裁和结案修复。两边的 PostgreSQL case 入口修复合并为 main 的完整映射表。

## 验证与证据边界

冻结的两份 GitHub 历史清单位于 `tests/fixtures/migration-histories/`。真实 PostgreSQL 用例覆盖 main、数字 A2 清单前缀、完整 A3、空库、main 升级中途失败并恢复；核对原迁移记录（含 applied_at）和测试业务行不变、重复执行无新增、部署 verify-prefix/verify-current/readiness 一致、漂移与未知迁移拒绝。每次迁移或部署敏感 Full Gate 自动纳入这组回归。

本地已在临时 PostgreSQL 16 实例执行五条升级路径，不能把 GitHub main 清单称为现场生产数据库的真实导出。部署前必须获取生产和 Acceptance 当前库的只读历史，并对最终候选执行下面的离线校验。现场存在未知迁移或手改 checksum 时保持阻断，不能绕过。

本地 PostgreSQL 回归共 108 项通过（上述五条升级路径及 sourcing、receiving、production-closure 三组业务用例），使用与 CI 一致的 UTC。API/Web 类型检查、构建与 lint 通过。GitHub Full Gate 与独立 Review 以本次 PR 最终 Head 的记录为准。

## 现场只读历史核对（不执行迁移）

由现有运维会话使用已配置的目标 `DATABASE_URL`，明确分别选择生产或 Acceptance，勿在输出中打印连接字符串。在对应环境执行一次：

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "SELECT json_build_object('migrations',coalesce(json_agg(json_build_object('version',version,'checksum',btrim(checksum)) ORDER BY version),'[]'::json)) FROM schema_migrations" \
  > production-migration-history.json
```

Acceptance 使用独立连接并另存 `acceptance-migration-history.json`。文件只有迁移名称/checksum，不包含连接凭据或业务订单。用本次候选目录离线检查：

```bash
node scripts/check-migration-export.mjs /absolute/path/production-migration-history.json
node scripts/check-migration-export.mjs /absolute/path/acceptance-migration-history.json
```

新候选也提供 `scripts/deploy/database-state.mjs export-history`，通过只读事务导出相同格式。`compatible` 仅表示迁移历史匹配，不等同部署或业务验收完成。

## 最终发布边界

用户负责最终部署。使用本次修复之后的候选，不能再直接发布旧 A3 `da6590cc`。先核对两份现场导出，再按既有 runbook 备份、升级、验证与 Acceptance 业务验收。不得重命名历史迁移、重新计算并覆盖数据库 checksum，或跳过历史检查。尚未取得现场导出时，交付状态是“代码兼容与隔离升级验证完成，现场历史核对待完成”。
