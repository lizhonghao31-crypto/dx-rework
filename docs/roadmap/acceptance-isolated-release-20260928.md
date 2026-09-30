# 数字生产平台｜独立 Acceptance/UAT 发布底座

> 2026-09-29 现场核验更新：现有 ECS 已运行独立 Acceptance API（3202）与独立
> `dx_rework_acceptance` 数据库，公网入口固定为
> `https://staging-api.dxerp.org.cn/acceptance/`。首次收口不再新购主机或新建域名；
> runtime 迁移到 `/opt/dx-rework-acceptance`，继续复用现有 shared-path 入口。
> 具体现场事实与切换步骤以
> `docs/roadmap/acceptance-environment-cutover-20260929.md` 为准；下文“独立主机/独立
> vhost”描述仅保留为原设计历史，不再作为本轮执行入口。

## 目标

为重大升级提供一套与正式生产隔离的可运行环境。该环境用于 Root 快速跑通、Acceptance Lab 多角色接力、真实数据库事务、站内待办与浏览器回归；不得向正式数据库、正式附件资源或真实钉钉待办写入。

## 固定隔离边界

| 对象 | Acceptance/UAT |
| --- | --- |
| 运行根目录 | `/opt/dx-rework-acceptance` |
| API 进程 | `dx-rework-acceptance-api` |
| API 本机端口 | `127.0.0.1:3202` |
| 数据库 | 名称必须包含 `acceptance` / `uat` / `test` |
| Node 环境 | `NODE_ENV=test` |
| Root | `uat-root` |
| 外部 Todo | 关闭 |
| 正式 OSS / OpenAI 写通道 | 禁止配置 |
| 正式站点 | 不修改、不重启、不作为 Acceptance URL |

## GitHub 发布方式

新增手动工作流 `Acceptance isolated release`。

- 输入精确40位commit SHA，因此可以验收尚未合并到main的候选版本。
- 默认 `dry_run=true`，只构建、扫描、打包，不连接ECS。
- 真正部署只使用 GitHub protected environment `dx-rework-acceptance` 中的独立SSH和公开验收URL配置。
- 工作流显式拒绝把 `https://dxerp.org.cn` 当作 Acceptance 公网入口。
- 数据库存在待执行迁移时，必须显式选择 `apply_migrations=true`。

## 一次性主机准备

该PR不会自行购买ECS、修改DNS或写入生产Nginx。运维侧准备独立Acceptance主机后：

1. 创建并授权 `/opt/dx-rework-acceptance/{incoming,shared,logs,releases,frontend/releases,generations,locks}`，目录不得group/world writable。
2. 将 `infra/acceptance/app.env.example` 和 `deploy.env.example` 复制为主机上的0600配置并替换占位值。
3. Acceptance PostgreSQL使用独立数据库；不要复制生产会话、Cookie、Token或正式员工身份。
4. 根据 `infra/nginx/dx-rework-acceptance.conf.example` 创建独立vhost，解析到3202；不要把Acceptance location加到正式 `dxerp.org.cn`。
5. 在GitHub建立 `dx-rework-acceptance` protected environment，配置该主机的独立SSH secrets和Acceptance公开HTTPS URL。

## 安全行为

- 远端脚本在迁移前读取真实 `current_database()`；数据库名不属于 acceptance/uat/test 立即终止。
- API启动仍会执行既有 Acceptance Server Guard，再次检查数据库、`uat-root`与外部副作用。
- PM2进程、日志、前端current alias和发布目录全部位于Acceptance根目录。
- 生产发布脚本、生产PM2配置、生产3201监听和生产Nginx模板均不在本PR修改。

## 本PR不做

- 不部署实际ECS。
- 不创建DNS/TLS证书。
- 不复制生产数据。
- 不接业务新流程。
- 不改变旧订单或正式系统。
