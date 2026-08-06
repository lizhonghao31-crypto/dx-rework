# PR-17 A 阶段发布与恢复手册

## 1. 固定边界

仅操作 `/opt/dx-rework`、PM2 进程 `dx-rework-api` 和独立返工 vhost。禁止修改或重载 ERP、样衣系统的目录、进程、数据库和 vhost。PR-17 的 routine release 只切换 API/frontend 的 `current` 软链接并 reload 单一 PM2 应用，**不执行 `nginx -s reload`**。Nginx 安装或配置变更属于单独的基础设施窗口，须另行批准。

## 2. 目标机配置

目标机使用三个相互隔离、普通文件、非软链接、属主为低权限部署用户且权限为 `0600` 的配置文件：

- `/opt/dx-rework/shared/.env`：应用运行变量；
- `/opt/dx-rework/shared/deploy.env`：Node 22 路径、独立域名、TLS、Nginx 配置路径和环境 profile；参考 `pr-17-deploy.env.example`；
- `/opt/dx-rework/shared/restore.env`：仅恢复演练目标库及批准指纹；参考 `pr-17-restore.env.example`。API 进程不会读取该文件。

`DX_REWORK_SERVER_NAME` 是 HTTPS smoke origin 的唯一来源，脚本自动派生 `https://<server_name>`，不接受第二个可漂移的 URL 配置。`DX_REWORK_NODE_BIN` 必须指向普通、非软链接、可执行的 Node 22 文件；发布、migration、manifest 和 API 启动统一使用该路径。

目标目录必须预先创建并由部署用户拥有，且不可 group/world writable：`releases`、`frontend/releases`、`shared`、`logs`、`backups`、`evidence`、`locks`、`incoming`。

## 3. 发布前门禁

1. 记录精确 Base、Head、GitHub Run ID、批准人和维护窗口。
2. Exact-Head CI 必须通过 lint、typecheck、build、全部测试、PostgreSQL migration replay、真实 backup→隔离 restore→readiness、release package/runtime/transfer checksum。
3. `build-release.sh SHA TIME OUTPUT` 或 CI 的 `package-release.sh` 生成不可变 bundle。
4. 目标机运行 `preflight.sh SHA BUNDLE`；任何 `fail|blocked` 都停止。
5. preflight 只读验证 Nginx `-t/-T`、TLS、vhost、目录、配置、Node、端口和 release checksum，不请求 Nginx reload 权限。

## 4. 发布顺序

`release.sh SHA BUNDLE` 默认 dry-run。真实执行需要同时满足：

```bash
DX_REWORK_APPLY=true
DX_REWORK_ENVIRONMENT_APPROVED=true
DX_REWORK_CONFIRM_RELEASE=<exact-40-char-sha>
DX_REWORK_APPLY_MIGRATIONS=true|false
```

固定顺序：

1. 加载并验证 app/deploy 配置，获取全流程独占锁；
2. preflight、bundle/API/frontend 三层 manifest 和 checksum；
3. **先安装 inactive release**，保证数据库变化前目标及恢复脚本已经在本机；
4. 验证数据库 migration history 是目标 manifest 的精确前缀；
5. 原子备份当前数据库，metadata 分别记录当前 schema 和目标 schema；
6. 有 pending migration 时必须显式批准后 apply；
7. 验证完整 version/checksum history，并运行数据库 readiness；
8. 原子切换 API/frontend 到同一 SHA，reload `dx-rework-api`，运行本地 API smoke；
9. 运行外部 HTTPS、页面、深链、asset、gzip、安全 header smoke；
10. 归档结构化证据并观察至少一个维护窗口。

## 5. 故障与恢复决策

- **activation 在 migration 前/无 migration 时失败**：activation trap 恢复 API/frontend 两条旧链接；首发则移除新链接并停止坏进程。
- **无 migration 的 external smoke 失败**：允许回到已登记且与数据库完全兼容的 previous SHA。rollback 失败时保留当前现场，禁止删除链接或停掉仍可用进程。
- **已 apply migration 后 activation 或 external smoke 失败**：禁止自动切回旧代码。保持目标 SHA 与证据，输出 `manual recovery required`；按 forward-fix 或已批准数据库恢复方案处理。
- **rollback**：只接受明确 SHA，且数据库 migration version/checksum 必须与目标 release 完全一致；rollback 自身只执行本地 readiness，不再触发第二次外部 smoke。
- P0 数据安全或跨系统影响：立即停止并隔离；P1 登录、审批、金额关键路径不可用：停止放量并按上述兼容性决策处理；P2 局部非关键故障：保留现场评估。

任何 checksum、schema、ready、PM2 cwd、双 current、TLS、日志泄露或锁异常均停止。失败不循环尝试其他 release，不删除失败 release、备份或日志。

## 6. 隔离恢复演练

恢复只允许在显式设置以下开关后执行：

```bash
DX_REWORK_RESTORE_DRILL=true
DX_REWORK_RESTORE_CONFIRM=RESTORE_TO_ISOLATED_DRILL
DX_REWORK_RESTORE_MANIFEST=<checksum-bound migration manifest>
```

目标数据库必须：名称匹配 `dx_rework_drill_*|dx_rework_restore_*`、指纹与 `restore.env` 批准值一致、与备份 metadata 的 source fingerprint 不同，并且不存在用户对象。恢复不依赖源库在线；只使用 checksum 覆盖的 metadata 与真实目标连接。恢复后必须通过完整 migration history、数据库 readiness 和最小一致性查询，并记录 RPO/RTO。不得 drop 或覆盖生产数据库。

## 7. 证据与外部事项

证据按 Head SHA/Run ID 归档，去除 query、Authorization、token、session、数据库 URL 和凭据。A 阶段自动化通过不等于真实 ECS、OSS、钉钉、Todo、UAT-01—UAT-22、广州尾部试点或 S-04 已完成；这些项目必须继续保持 `blocked/not_run`，直到获得独立授权和双人证据。

若撤销 A 阶段代码，revert PR-17 对应提交；不得删除 migration 或清空业务数据。
