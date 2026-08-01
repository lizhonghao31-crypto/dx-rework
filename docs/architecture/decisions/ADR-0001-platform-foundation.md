# ADR-0001：PR-01 技术基座

- 状态：Accepted
- 日期：2026-08-01
- 基线：`main@082f9c0656feebc2a36bb4717d0e3c043194e565`

## 决策

1. 使用 npm workspaces 管理 `apps/web`、`apps/api` 与独立 packages，锁定 Node 22、npm 10。
2. 前端沿用 ERP 已验证的 React 19、Vite 8 版本方向，但不复制 ERP 页面或巨型单文件；Vite 使用已修复安全公告的 8.2.0，而不是机械复制 ERP 当时的旧补丁版本。
3. API 使用 Fastify 与 TypeScript，统一 request ID、错误契约和结构化脱敏日志。
4. PR-01 以 PostgreSQL 16 为默认关系数据库，迁移采用带 checksum 的版本化 SQL；平台首迁移只建立审计、outbox 和幂等基础表，不建立返工业务表。
5. liveness 与 readiness 分离；`/version` 同时返回 Git SHA、构建时间、已应用 schema 版本和预期 schema 版本。
6. ERP 仅保留显式 adapter 接口，默认 disabled；本 PR 不读写 ERP。
7. ECS 只交付独立目录、端口、PM2、Nginx、日志轮转和备份模板，不执行部署。

## 理由

- 复用 ERP 已验证的 Node/React/Vite 与运维结构经验，同时避开通行码、姓名权限、JSON store、混合 vhost 和不可追溯 release 等历史风险。
- PostgreSQL 提供事务、唯一约束、JSONB、并发控制和 advisory lock，适合后续上数、金额、幂等和 outbox；在业务表出现前仍可低成本调整。
- 独立应用、数据库和运维命名使新系统故障不传导至 ERP，并保留未来 ERP 节点接入能力。

## 约束与风险

- 若公司统一数据库标准最终要求 MySQL 8，必须在首个返工业务迁移前新增 ADR，并替换本平台迁移；不得并存两套生产数据库。
- 当前 migration runner 是最小可审计实现；后续涉及回滚时采用 forward-fix，破坏性迁移必须单独审批。
- PR-01A 才实现已验收 Figma 的设计 token 和业务组件；本 PR 的诊断页不是业务 UI Golden Source。

## 回滚

关闭或 revert PR-01。由于不部署、不连接生产且只有平台空表，回滚不会触碰 ERP 或业务数据。
