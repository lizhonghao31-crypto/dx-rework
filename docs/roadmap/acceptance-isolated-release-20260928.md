# 数字生产平台｜独立 Acceptance/UAT 发布底座

## 目标

为重大升级提供一套与正式生产隔离的可运行环境。该环境用于 Root 快速跑通、Acceptance Lab 多角色接力、真实数据库事务、站内待办与浏览器回归；不得向正式数据库、正式附件资源或真实钉钉待办写入。

## 当前落地决策

复用现有 staging HTTPS origin，不新增域名/TLS：

- 公网入口：`https://staging-api.dxerp.org.cn/acceptance/`
- Nginx：只在现有 staging `server {}` 内增加 `/acceptance/**` location 块
- Acceptance 运行时、数据库、目录、PM2、日志仍与 `/rework/**` 和 production 完全隔离
- routine Acceptance release 不 reload Nginx；首次 location 安装属于一次性基础设施窗口

这个决定只复用 HTTPS 入口层，不复用生产/旧 Pilot 应用运行时。

## 固定隔离边界

| 对象 | Acceptance/UAT |
| --- | --- |
| 公网 namespace | `/acceptance/` |
| 运行根目录 | `/opt/dx-rework-acceptance` |
| API 进程 | `dx-rework-acceptance-api` |
| API 本机端口 | `127.0.0.1:3202` |
| 数据库 | 独立库，名称必须包含 `acceptance` / `uat` / `test` |
| Node 环境 | `NODE_ENV=test` |
| Root | `uat-root` |
| 外部 Todo | 关闭 |
| 正式 OSS / OpenAI 写通道 | 禁止配置 |
| 正式 `dxerp.org.cn` | 不修改、不重启、不作为 Acceptance URL |
| staging `/rework/**` | 不修改应用运行时，不共用 3201、目录或数据库 |

## GitHub 发布方式

手动工作流 `Acceptance isolated release`：

- 输入精确40位 commit SHA，可验收尚未合并到 main 的候选版本；
- 构建固定使用 `APP_BASE_PATH=/acceptance/` 与 `VITE_BASE_PATH=/acceptance/`；
- 默认 `dry_run=true`，只构建、扫描、打包；
- 真正部署只使用 protected environment `dx-rework-acceptance`；
- `DX_REWORK_ACCEPTANCE_PUBLIC_URL` 必须精确指向 `https://staging-api.dxerp.org.cn/acceptance`（允许末尾斜杠）；
- 数据库有 pending migration 时必须显式 `apply_migrations=true`。

## 一次性宿主准备

正式业务施工前必须完成一次真实主机窗口：

1. 核验现有 staging ECS 的 SSH 入口、运行用户、Nginx 配置文件、TLS 与本机 PostgreSQL 可用性；
2. 创建专用低权限 Acceptance 部署用户，不复用 production 应用运行账号的写权限；
3. 创建并授权：
   `/opt/dx-rework-acceptance/{incoming,shared,logs,releases,frontend/releases,generations,locks}`；
4. 建立独立 PostgreSQL 数据库和最小权限账号，禁止使用 production 数据库；
5. 将 `infra/acceptance/app.env.example`、`deploy.env.example` 落为 0600 普通文件；
6. 将 `infra/nginx/dx-rework-acceptance-shared-paths.conf.example` 的标记块加入现有 staging HTTPS server；
7. 备份 Nginx 配置，执行 `nginx -t`，经批准后 graceful reload；
8. 验证 `/rework/**`、ERP、样衣等既有 staging 路由不受影响；
9. 在 GitHub `dx-rework-acceptance` environment 设置：
   - `DX_REWORK_SSH_HOST`
   - `DX_REWORK_SSH_USER`
   - `DX_REWORK_SSH_KEY`
   - `DX_REWORK_SSH_HOST_KEY`
   - `DX_REWORK_ACCEPTANCE_PUBLIC_URL=https://staging-api.dxerp.org.cn/acceptance`

SSH 私钥、数据库密码、SESSION_SECRET、ACCEPTANCE_LAB_SECRET 不得写入仓库、PR、日志或 Artifact。

## 安全行为

- 远端脚本在 migration 前读取真实 `current_database()`；库名不属于 acceptance/uat/test 立即停止；
- API 启动执行 Acceptance Server Guard，检查独立库、`uat-root`和外部副作用；
- PM2进程、日志、前端current alias和发布目录全部位于 Acceptance 根目录；
- Nginx shared-path 模板明确禁止 upstream 3201；
- Acceptance 不配置正式 OSS、OpenAI 或真实 Todo delivery/timing；
- production 发布脚本、production PM2、production 3201 和 `dxerp.org.cn` 正式 vhost 不在 ENV-01 修改。

## ENV-01 完成门槛

只有同时满足以下事实，才能开始 P01 正式业务施工：

1. `https://staging-api.dxerp.org.cn/acceptance/health/ready` 成功；
2. `/acceptance/version` 返回精确候选 SHA 和正确 schema；
3. `/acceptance/ui/acceptance-lab` 可打开；
4. Acceptance Lab UAT Root 与多角色切换真实可用；
5. 独立数据库 migration/transaction 可写，production 数据库无写入；
6. 测试附件写入独立测试区或明确关闭，不命中正式 OSS；
7. 新版座舱真实页面可截图；
8. 至少完成一次候选版本更新，证明不是“一次性装上去但无法升级”；
9. production 与 staging `/rework/**` 不受影响；
10. 产生绑定精确 SHA 的验收 Artifact。

## ENV-01 不做

- 不开发 P01—P16 业务功能；
- 不复制 production 数据；
- 不接钉钉外部通知；
- 不把离线组件截图当成 Acceptance 已部署；
- 不以“workflow/PR已合并”替代真实站点验收。
