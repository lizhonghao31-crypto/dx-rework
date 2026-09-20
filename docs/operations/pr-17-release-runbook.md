# PR-17 发布与恢复手册

> 2026-09-19 OPS-05 production-domain update: 正式生产入口切换目标为
> `https://dxerp.org.cn/`，生产使用 `dedicated_vhost` 与根路径
> `APP_BASE_PATH=/`。旧 `staging-api.dxerp.org.cn/rework/**` 仅作为迁移兼容入口；
> `staging-api.dxerp.org.cn/acceptance/**` 继续承载独立验收环境。

## 1. 固定边界

返工系统运行时只操作 `/opt/dx-rework`、PM2 进程 `dx-rework-api`、本机监听 `127.0.0.1:3201`、返工独立 PostgreSQL 数据库/迁移、独立日志/备份/release/generation。禁止修改或重启 ERP、样衣系统的目录、进程、数据库和运行配置。

历史 Pilot/验收曾复用 `https://staging-api.dxerp.org.cn/rework/` 的 **shared-path** 部署。该模式仍保留用于非生产环境；正式生产不再以该路径作为主入口。生产 `dxerp.org.cn` 根域直接服务 `/opt/dx-rework/frontend/current` 并将根级 API 转发至 `127.0.0.1:3201`。旧 `/rework/**` 链接通过独立兼容配置迁移到正式根域，不能重新成为生产事实源。

仓库同时保留两种发布布局：当前 ECS 正式生产由 `scripts/deploy-ecs.sh` 采用 **source layout**，即 `/opt/dx-rework/current -> /opt/dx-rework/source`，前端指向 `/opt/dx-rework/frontend/source-releases/<SHA>`；PR-17 packaged release 采用 **generation layout**，即 `current -> active/api -> generations/<SHA>`。任何运维脚本必须以 `current` 的真实解析结果为事实源，不能因为机器上存在旧 `active/generations` 就假定 production 正在使用 generation layout。两种布局都不得在备份任务中改写 alias。

Nginx 安装或配置变更属于单独的基础设施窗口，须另行批准并先备份、执行 `nginx -t` 后再由基础设施操作完成 graceful reload。shared-path 模式使用 `infra/nginx/dx-rework-shared-paths.conf.example` 的标记块作为审查基线；该块必须原样存在于配置文件与 `nginx -T` 输出中。`release-switch.lock` 只能在 `/rework/**` locations 内返回 503，**绝不能在共享 `server {}` 顶层使整个 staging origin 返回 503**。

`dedicated_vhost` 现为 production 正式模式；`shared_path` 仅保留给 Pilot/兼容环境。部署模式必须由 `DX_REWORK_NGINX_MODE=shared_path|dedicated_vhost` 显式指定，不得根据 hostname 猜测。

## 2. 目标机配置与目录

目标机使用三个相互隔离、普通文件、非软链接、属主为低权限部署用户且权限为 `0600` 的配置文件：

- `/opt/dx-rework/shared/.env`：应用运行变量；Production 必须使用 `APP_BASE_PATH=/`、`DINGTALK_QR_REDIRECT_URI=https://dxerp.org.cn/auth/qr/relay`、`TODO_PUBLIC_BASE_URL=https://dxerp.org.cn/`；Pilot shared-path 使用 `APP_BASE_PATH=/rework/`；PR-31 首位老板 bootstrap 的 userid/secret 两项默认均不配置，仅允许在明确的一次性初始化窗口成对注入；
- `/opt/dx-rework/shared/deploy.env`：Node 22 路径、PostgreSQL 客户端目录、显式 Nginx 模式、HTTPS server name、TLS、真实 Nginx 配置路径和环境 profile；Production 必须将 `DX_REWORK_PG_BIN_DIR` 固定到与生产数据库主版本兼容的客户端目录（当前 ECS 为 `/usr/pgsql-16/bin`）；参考 `pr-17-deploy.env.example`；
- `/opt/dx-rework/shared/restore.env`：仅恢复演练目标库及批准指纹；参考 `pr-17-restore.env.example`。API 进程不会读取该文件。

首位老板 bootstrap 窗口是独立的安全操作窗口，不与 release/rollback 并发：只有**包含首位老板 bootstrap 能力、且其 migration manifest 与当前数据库完整一致**的 release 已稳定运行后，才允许临时把 `OWNER_BOOTSTRAP_DINGTALK_USER_ID` 与 `OWNER_BOOTSTRAP_SECRET` 成对写入 `.env` 并仅 reload `dx-rework-api`。完成一次性 bootstrap 后必须立即从 `.env` 删除两项、再次 reload 并确认 bootstrap 回到默认关闭状态。窗口期间禁止发起发布或代码回滚；尤其不得尝试回滚到不认识这两个环境键的更早 start wrapper。数据库的一次性 consumption 记录不因删除环境变量而撤销。

配置文件是唯一事实源。加载前脚本会清空对应 allowlist 变量，文件缺失的值不得从调用 shell、PM2 或历史会话继承。`DX_REWORK_NODE_BIN` 必须指向普通、非软链接、可执行的 Node 22 文件；发布、migration、manifest 和 API 启动统一使用该路径。

`DX_REWORK_SERVER_NAME` 只定义 HTTPS origin。shared-path 模式自动派生：

```text
Web base = https://<server_name>/rework
API base = https://<server_name>/rework/api
```

本机激活 smoke 始终直接访问 `http://127.0.0.1:3201` 的根 API 路径，不经过共享 Nginx。

目标目录必须预先创建并由部署用户拥有，且不可 group/world writable：`releases`、`generations`、`frontend/releases`、`shared`、`logs`、`backups`、`evidence`、`locks`、`incoming`。任何遗留 `release-switch.lock` 都表示上次发布尚未恢复完成，preflight 必须停止，不能自动删除。

## 3. 发布前门禁

1. 记录精确 Base、Head、GitHub Run ID、批准人和维护窗口。
2. Exact-Head CI 必须通过 lint、typecheck、build、全部测试、PostgreSQL migration replay、真实 backup→隔离 restore→readiness、partial migration fault injection、generation activation/restore、release package/runtime/transfer checksum。
3. UAT validator 必须获得待发布的精确 40 位 SHA；任何非 `not_run` 证据的 `gitSha` 必须与其一致。
4. `build-release.sh SHA TIME OUTPUT` 或 CI 的 `package-release.sh` 生成不可变 bundle。
5. 目标机运行 `preflight.sh SHA BUNDLE`；任何 `fail|blocked` 都停止。
6. preflight 只读验证 Nginx `-t/-T`、TLS、query-free 日志、维护闸门、目录、配置、Node、端口和 release checksum，不请求 Nginx reload 权限。
7. `shared_path` 额外必须验证：`APP_BASE_PATH=/rework/`；目标 server 已加载；标记的 `/rework/**` 配置块在磁盘与 `nginx -T` 完全一致；不存在返工根级路由；API upstream 全部为 `127.0.0.1:3201`；前端路径全部在 `/opt/dx-rework/frontend/current`；QR relay/callback 关闭 request-line access/error 日志；维护闸门只在 `/rework/**` 内；缺失、重复、冲突或越界一律停止。
8. `dedicated_vhost` 保留原独立 server/TLS/维护闸门检查，不因 shared-path 支持而弱化。

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
7. migration 失败且数据库状态已变化时，立即创建 `release-switch.lock`，保持旧 API 进程；shared-path 下仅 `/rework/**` 对外返回 503，并进入 `manual recovery required`；
8. migration 全部成功后验证完整 version/checksum history 与数据库 readiness；
9. activation 创建维护闸门，只原子切换 `active` 到目标 generation，reload `dx-rework-api` 并运行本地 API smoke；通过后删除维护闸门；
10. 运行外部 HTTPS smoke。shared-path 只访问 `/rework/` Web 与 `/rework/api/` API，不探测、不修改共享 origin 的其他根路径；
11. 归档结构化证据并观察至少一个维护窗口。

**不得在手册中固定假定“当前数据库版本 → 目标版本”。** 发布时唯一事实源是目标 release 的 `apps/api/src/platform/migration-manifest.json` 与目标数据库的真实 migration history。必须先运行 `database-state.mjs verify-prefix` / preflight；只有实时检查确认存在 pending migration 时，才设置 `DX_REWORK_APPLY_MIGRATIONS=true`。历史文档中的旧版本号不能替代该检查。

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

shared-path 模式下，若发现 `/rework/**` 之外的 staging/ERP/样衣路径因返工 release 或 maintenance flag 受到影响，按跨系统 P0 处理：停止发布、保留证据，并在独立 Nginx 基础设施窗口修复路由；routine release 不得自行 reload Nginx 规避。

## 6. 隔离恢复演练

恢复只允许在显式设置以下开关后执行：

```bash
DX_REWORK_RESTORE_DRILL=true
DX_REWORK_RESTORE_CONFIRM=RESTORE_TO_ISOLATED_DRILL
DX_REWORK_RESTORE_MANIFEST=<checksum-bound migration manifest>
```

目标数据库必须：名称匹配 `dx_rework_drill_*|dx_rework_restore_*`、指纹与 `restore.env` 批准值一致、与备份 metadata 的 source fingerprint 不同，并且不存在用户对象。恢复不依赖源库在线；只使用 checksum 覆盖的 metadata 与真实目标连接。恢复后必须通过完整 migration history、数据库 readiness 和最小一致性查询，并记录 RPO/RTO。不得 drop 或覆盖生产数据库。

## 6.1 每日 PostgreSQL 备份与失败可发现性

生产数据库日备份使用独立目录 `/opt/dx-rework/backups/postgres/daily`，不与 release migration 前备份混合清理。systemd timer 固定按 `Asia/Shanghai` 每日 23:30 执行；安装时先立即执行一次备份并通过健康检查后才启用定时器。

`run-scheduled-postgres-backup.sh` 必须从 `/opt/dx-rework/current` 所指向的真实运行布局读取 Git SHA 与 migration manifest，验证生产数据库完整 migration history 后调用正式 `backup-postgres.sh`。备份必须产生 `COMPLETE`、通过 `SHA256SUMS` 与 `pg_restore --list`，成功后才允许执行保留策略。日备份与 routine release 共用 release 锁：备份最多等待 30 分钟，禁止与 migration / generation 切换并发；若备份先取得锁，发布必须等待或停止。默认只保留最近 14 个**成功的日备份集**；只清理 daily 专用目录中具备完整安全标记的旧集合，不触碰 release/manual 备份。

成功证据写入 `/opt/dx-rework/evidence/ops03/daily-backup-last-success.json`；失败写入独立 failure 证据。每天 08:30 的 health timer 验证最近成功备份不超过 30 小时、完整性仍有效且不存在更新的未解决失败。备份 service 或 health service 失败会保持 systemd failed 状态并保留证据，供 OBS-01/人工巡检发现；本机制本身不发送钉钉消息，也不读取或输出生产密钥。

安装/更新 systemd 单元必须由 root 显式执行当前 `current` 中的 `install-postgres-backup-timer.sh`。当前生产若为 source layout，安装器必须验证 source checkout、release manifest、frontend source-release 与 migration manifest 一致；若为 generation layout，则验证 active/generation 链路一致。routine release 仅携带这些脚本和 unit，不自动修改 `/etc/systemd/system`。

## 7. 证据与外部事项

证据按 Head SHA/Run ID 归档，去除 query、Authorization、token、session、数据库 URL 和凭据。代码自动化通过不等于真实 ECS、共享 Nginx 配置窗口、OSS、钉钉、Todo、UAT-01—UAT-22、广州尾部试点或 S-04 已完成；这些项目必须保持真实状态，禁止用 CI 代替现场证据。

shared-path Nginx 配置只在单独基础设施窗口落地：备份现有 staging 配置 → 注入/核验标记块 → `nginx -t` → 人工/基础设施批准的 graceful reload → 验证 ERP/样衣原有路径不变 → 才允许 PR-17 routine release 使用该配置。

若撤销 PR-17 部署代码，使用新的代码回退提交；不得删除、重写已合并 migration 或清空业务数据。
