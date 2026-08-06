# PR-17 A 阶段发布与恢复手册

## 1. 固定边界

仅操作 `/opt/dx-rework`、PM2 进程 `dx-rework-api` 和独立返工 vhost。禁止修改或重载 ERP、样衣系统的目录、进程、数据库和 vhost。PR-17 routine release 只原子切换 `/opt/dx-rework/active` 这一个 generation 指针并 reload 单一 PM2 应用，**不执行 `nginx -s reload`**。`/opt/dx-rework/current` 与 `/opt/dx-rework/frontend/current` 是永久稳定别名，分别解析到 `active/api` 与 `active/frontend`，不得在 routine release 中单独改写。

Nginx 安装或配置变更属于单独的基础设施窗口，须另行批准。80/443 两个 server 都使用不记录 query string 的 `dx_rework_query_free` access log；TLS server 在 `/opt/dx-rework/shared/release-switch.lock` 存在时返回 503，防止切换期间出现跨 SHA 请求。

## 2. 目标机配置与目录

目标机使用三个相互隔离、普通文件、非软链接、属主为低权限部署用户且权限为 `0600` 的配置文件：

- `/opt/dx-rework/shared/.env`：应用运行变量；
- `/opt/dx-rework/shared/deploy.env`：Node 22 路径、独立域名、TLS、Nginx 配置路径和环境 profile；参考 `pr-17-deploy.env.example`；
- `/opt/dx-rework/shared/restore.env`：仅恢复演练目标库及批准指纹；参考 `pr-17-restore.env.example`。API 进程不会读取该文件。

配置文件是唯一事实源。加载前脚本会清空对应 allowlist 变量，文件缺失的值不得从调用 shell、PM2 或历史会话继承。`DX_REWORK_SERVER_NAME` 是 HTTPS smoke origin 的唯一来源，脚本自动派生 `https://<server_name>`。`DX_REWORK_NODE_BIN` 必须指向普通、非软链接、可执行的 Node 22 文件；发布、migration、manifest 和 API 启动统一使用该路径。

目标目录必须预先创建并由部署用户拥有，且不可 group/world writable：`releases`、`generations`、`frontend/releases`、`shared`、`logs`、`backups`、`evidence`、`locks`、`incoming`。任何遗留 `release-switch.lock` 都表示上次发布尚未恢复完成，preflight 必须停止，不能自动删除。

## 3. 发布前门禁

1. 记录精确 Base、Head、GitHub Run ID、批准人和维护窗口。
2. Exact-Head CI 必须通过 lint、typecheck、build、全部测试、PostgreSQL migration replay、真实 backup→隔离 restore→readiness、partial migration fault injection、generation activation/restore、release package/runtime/transfer checksum。
3. UAT validator 必须获得待发布的精确 40 位 SHA；任何非 `not_run` 证据的 `gitSha` 必须与其一致。
4. `build-release.sh SHA TIME OUTPUT` 或 CI 的 `package-release.sh` 生成不可变 bundle。
5. 目标机运行 `preflight.sh SHA BUNDLE`；任何 `fail|blocked` 都停止。
6. preflight 只读验证 Nginx `-t/-T`、TLS、query-free 日志、维护闸门、目录、配置、Node、端口和 release checksum，不请求 Nginx reload 权限。

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
3. **先安装 inactive release 并登记 generation**，保证数据库变化前目标及恢复脚本已经在本机；
4. 验证数据库 migration history 是目标 manifest 的精确前缀；
5. 原子备份当前数据库，metadata 分别记录当前 schema 和目标 schema；
6. 有 pending migration 时必须显式批准后 apply；每个 migration 独立提交，命令失败后必须重新读取数据库状态；
7. migration 失败且数据库状态已变化时，立即创建 `release-switch.lock`，保持旧 API 进程但对外返回 503，并进入 `manual recovery required`；
8. migration 全部成功后验证完整 version/checksum history 与数据库 readiness；
9. activation 创建维护闸门，只原子切换 `active` 到目标 generation，reload `dx-rework-api` 并运行本地 API smoke；通过后删除维护闸门；
10. 运行外部 HTTPS、页面、深链、asset、gzip、安全 header smoke；
11. 归档结构化证据并观察至少一个维护窗口。

## 5. 故障与恢复决策

- **migration 未改变数据库即失败**：旧 generation 和旧 API 保持运行，不创建维护闸门；修正 migration 后重新发布。
- **migration 部分提交或 migration 后 readiness 失败**：旧代码可能已不兼容，立即保持维护闸门，禁止自动切回数据库或旧代码；只能 forward-fix 或执行已批准的数据库恢复。
- **无 migration 的 activation 失败**：activation trap 把单一 `active` 指针恢复到 previous generation；首发则移除 `active` 并停止坏进程。
- **有 migration 的 activation 失败**：保持目标 generation 和维护闸门，输出 `manual recovery required`。
- **无 migration 的 external smoke 失败**：允许回到已登记且与数据库完全兼容的 previous SHA。rollback 失败时保留现场并重新开启维护闸门。
- **有 migration 的 external smoke 失败**：保持目标 generation，重新开启维护闸门，禁止自动切回旧代码。
- **rollback**：只接受明确 SHA，且数据库 migration version/checksum 必须与目标 release 完全一致；rollback 自身只执行本地 readiness，不再触发第二次外部 smoke。
- P0 数据安全或跨系统影响：立即停止并隔离；P1 登录、审批、金额关键路径不可用：停止放量并按上述兼容性决策处理；P2 局部非关键故障：保留现场评估。

任何 checksum、schema、ready、PM2 cwd、active generation、稳定别名、TLS、日志泄露、维护闸门或锁异常均停止。失败不循环尝试其他 release，不删除失败 release、备份或日志。维护闸门只能在确认 API、本地 smoke、数据库状态及 generation 一致后人工或由成功的 activation/rollback 删除。

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
