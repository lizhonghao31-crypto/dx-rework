# 样衣 PR-1：领域基础与迁移来源

## 施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: a2b5e134f269c10cebec37525070128a059fe069
working branch: feat/sample-01-foundation
task scope: 样衣领域基础、权限边界、只读盘点和可重复迁移来源暂存
allowed files: apps/api/src/samples/*; apps/api/migrations/0152_sample_domain_foundation.sql; apps/api/src/platform/migration-manifest.json; packages/contracts/src/samples.ts; packages/contracts/src/index.ts; scripts/sample-inventory.ts; tests/unit/sample-foundation.test.ts; tests/integration/sample-foundation-postgres.test.ts; docs/evidence/sample-01-foundation.md
forbidden files: 已有返工/外发/工资业务实现、已有迁移 SQL、认证实现、现有 UI/CSS、生产数据
```

业务基线：`docs/requirements/sample-system-migration-v1.0.md`。本次任务获业务负责人授权逐个 PR 验证、最多一次 Codex Review、合并及继续后续 PR；生产数据对账与上线门槛保持有效。

必要的门禁接入：`scripts/run-business-chain-gate.mjs` 仅在现有数据库测试清单中增加样衣 PostgreSQL 用例，不更改其他测试、触发条件或 runner 拓扑。

## 本 PR 的交付边界

- 新增样衣领域表、唯一请求/当前借用约束、精确金额字段、不可覆盖的来源记录与逻辑归档保护。
- 样衣设计师、行政、财务独立角色；老板使用现有 owner_group；普通 system_admin 无样衣业务权限；root 继续复用平台已验证身份。
- 服务端字段白名单隔离采购价、小票和未来新增敏感字段。
- 只读盘点脚本保存业务源快照、规范化哈希、对象清单与异常；不搬运旧密码配置、用户权限或二维码会话。
- `stageSampleSource` 仅供受信任服务端 root 上下文暂存源证据，同一快照并发重复执行只写一次，并追加平台审计。
- 本阶段不开放入口、不导入活跃样衣、不执行生产写入；活跃业务导入及切换在 PR-5 完成，并使用本阶段保留的逐条来源。

## 真实只读盘点

来源：旧仓库实际后端 `sample-ecs-server/server/native-sample-api.cjs` 与部署脚本确认的 `GET /sample/api/cloud-db`，不是浏览器本地数据。

本次业务源快照哈希：`dbfe811a8a8a8bcaefaaeff0532d29334a866f0de5ad8732c71f2088143e1379`。

| 项目 | 结果 |
|---|---:|
| 样衣 | 540 |
| 日志 | 784 |
| 状态为 BORROWED | 540 |
| 去重附件对象引用 | 563 |
| 缺采购小票的样衣 | 4 |
| 日志关联的样衣当前不存在 | 55 |
| 待明确映射的采购人/持有人引用 | 1080 |

1080 是逐件人员引用数量，不是不同人员数量。全部采购金额可按十进制解析。对象引用已规范化去重，尚不代表逐对象可访问性已通过。孤儿日志保留原文；不创建虚构样衣或用户去消除差异。包含人员、金额、附件的实际快照和逐条异常清单不得提交 GitHub。

## 验证与后续门槛

- 定向测试覆盖全部样衣能力的允许/拒绝、字段裁剪、金额、未知状态、孤儿历史、重复 ID 和源哈希。
- PostgreSQL 测试覆盖库存/持有人约束、唯一活跃请求、唯一当前借用、不可覆盖历史、并发幂等暂存与审计。
- 当前 Head 的 Full Gate 和一次 Codex Review 为合并门槛；具体结果以 GitHub 当前 Head 为准。
- 本 PR 没有 UI，真实五尺寸页面验收从 PR-2 开始。

## 运行与回退

```bash
node --import tsx scripts/sample-inventory.ts INPUT.json NEW_OUTPUT_DIRECTORY
node --import tsx scripts/sample-inventory.ts --read-legacy-api NEW_OUTPUT_DIRECTORY
```

输出目录必须不存在，权限为 0700，文件为 0600；脚本只读生产 API，不写数据库。数据源 settings、users 和旧 QR 会话明确排除；样衣及历史原值保留。

回退代码即可撤下本阶段能力；已应用的新增表和迁移历史保留，不删除历史迁移、不物理清除暂存数据。尚未开放任何样衣生产写入口，旧系统继续正常运行。正式切换前必须处理人员映射、附件和历史异常，并在隔离环境重复导入及逐项对账。
