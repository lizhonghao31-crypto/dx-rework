# PR-17 shared staging vhost 修复预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 7c48902c6506e529f67f480f784d18c11f4a382c
working branch: fix/pr17-shared-staging-vhost
task scope: 让 PR-17 部署门禁与已确认的 https://staging-api.dxerp.org.cn/rework/ 共享域名方案一致，同时把维护闸门和全部返工公网路由严格限制在 /rework/ 命名空间
implementation mode: Incremental Injection
allowed files: scripts/deploy/**、infra/nginx/**、docs/operations/pr-17-*、docs/plan/pr-17-ecs-pilot-go-live.md、docs/plan/pr-roadmap-v2.0.md、tests/**、本预检文件；如确有必要仅允许 .env.example/package.json 的部署变量或测试命令增量
forbidden files: apps/api/migrations/**、既有业务 service/state machine/金额/工资/责任/扣款/审批逻辑、业务 UI/CSS、ERP 仓库、生产 ECS/RDS/DNS/钉钉后台、线上密钥
```

## 已确认事实

- Pilot/验收继续使用 `https://staging-api.dxerp.org.cn/rework/`，复用 dxerp 系现有证书；不新建独立返工域名。
- 返工运行时继续独立：`/opt/dx-rework`、PM2 `dx-rework-api`、127.0.0.1:3201、独立 PostgreSQL 数据库/迁移、日志、release/generation、备份与恢复。
- 共享 vhost 只承担 `/rework/` 路由；不得修改、重启或 reload ERP/样衣应用进程。
- PR-17 当前对 `staging-api.dxerp.org.cn` 的硬编码拒绝属于旧部署假设，必须改为可验证的 shared-path 模式，而不是直接删除所有隔离校验。
- shared-path 模式下，`release-switch.lock` 只能使 `/rework/**` 返回 503，绝不能使整个 `staging-api.dxerp.org.cn` 返回 503。
- shared-path 模式下，返工健康/version 只通过 `/rework/api/health/live`、`/rework/api/health/ready`、`/rework/api/version` 暴露；不得抢占共享域名根级 `/health/*` 或 `/version`。
- DingTalk QR relay 继续使用同源 `https://staging-api.dxerp.org.cn/rework/auth/qr/relay`，该精确路径必须关闭 access/error request-line 日志。
- 当前应用外部 base path 为 `/rework/`；Session/QR binding Cookie 继续按 APP_BASE_PATH 限制在 `/rework/`。
- 当前 main schema 目标为 `0033_employee_access_management`；本修复不得新增、删除、重写任何 migration。

## 修复验收口径

1. 部署配置显式区分 `shared_path` 与 `dedicated_vhost`，默认不得靠域名猜模式。
2. `shared_path` 必须要求 `APP_BASE_PATH=/rework/`，允许 `DX_REWORK_SERVER_NAME=staging-api.dxerp.org.cn`。
3. preflight 对 shared-path 的真实 `nginx -T`/配置执行 fail-closed 校验：`/rework/api/` 只反代 `127.0.0.1:3201`，`/rework/assets/`/SPA 只读取 `/opt/dx-rework/frontend/current`，QR relay/callback 脱敏，维护闸门仅限 `/rework/**`。
4. shared-path 不要求独占 `server_name`，但必须证明目标 server 已加载且返工 location 不越界；dedicated 模式保留原独立 vhost 校验。
5. external smoke 必须分别使用 `https://<server>/rework/` Web base 和 `https://<server>/rework/api/` API base；本地 3201 smoke 保持根 API 路径。
6. release/rollback/activation 仍禁止全局 Nginx reload、PM2 broad control、ERP/样衣目录写入。
7. 将 PR-31 新增的 owner bootstrap 两个环境变量加入受控 app env allowlist，但默认仍关闭，不写入任何真实值。
8. 新增/更新测试锁定以上边界；不得通过弱化测试或删除现有 fail-closed 门禁取得全绿。
