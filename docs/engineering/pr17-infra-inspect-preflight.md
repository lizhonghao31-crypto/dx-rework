# PR-17B 只读基础设施检查预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 4a9f58ad35ba598a7b4bc8ef410330a567c885b8
working branch: chore/pr17-readonly-infra-inspect
task scope: 通过既有 dx-rework-pilot GitHub Environment/SSH secrets 对 ECS 执行可审计、只读、脱敏的 PR-17B 基础设施检查，消除人工抄录 Nginx/TLS/PM2/运行版本事实
authorized remote target: 仅既有 DX_REWORK_SSH_HOST / DX_REWORK_SSH_USER；仅 staging-api.dxerp.org.cn
allowed files: .github/workflows/pr-17-infra-inspect.yml、scripts/deploy/inspect-shared-host.sh、tests/unit/pr-17-infra-inspect.test.ts、本预检文件
forbidden: 任何 migration、业务代码/UI、ECS 文件写入、Nginx reload/restart、PM2 状态修改、数据库连接/写入、OSS/钉钉调用、secret 值输出、生产 environment
```

## 安全契约

- Workflow 仅 `workflow_dispatch`，只允许 `dx-rework-pilot` environment；必须显式输入当前精确 main SHA，checkout 后再次确认 `origin/main` 完全一致。
- 复用现有 `DX_REWORK_SSH_HOST`、`DX_REWORK_SSH_USER`、`DX_REWORK_SSH_KEY`、`DX_REWORK_SSH_HOST_KEY`，不得打印任何 secret。
- 远端脚本通过 SSH stdin 临时执行，不 scp、不安装、不持久化脚本；除安全临时文件外不得写 ECS。
- 允许的 sudo 只限只读/校验：`nginx -t`、`nginx -T`；不得 reload、restart、stop、start、kill、修改配置。
- Nginx 输出只提取安全元数据：目标 server 所在配置文件、证书/私钥路径、`/rework` location 声明、3201 upstream、dx-rework frontend path、maintenance gate、query-free log_format 是否存在；不得原样输出整份 `nginx -T`。
- `.env` 只输出键名及少量非敏感状态（如 APP_BASE_PATH、bootstrap key 是否存在），绝不输出 DATABASE_URL、DingTalk/OSS/session/bootstrap secret 值。
- PM2 只输出 `dx-rework-api` 的 name/status/cwd/script，不输出完整 PM2 env。
- 本地 API 只读 `/version`、`/health/live`、`/health/ready`；`/version` 只保留 gitSha/schema 字段。
- 任何检查失败可以记录为 `missing/unavailable` 并继续收集其它只读事实；SSH/host key/脚本自身安全校验失败则整个 workflow 失败。
