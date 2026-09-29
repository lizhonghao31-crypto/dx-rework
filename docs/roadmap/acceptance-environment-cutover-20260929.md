# Acceptance/UAT 现网收口记录（2026-09-29）

## 已核验现状

现网已有旧 Acceptance 运行时，但它不是当前发布脚本所要求的 generation layout：

- 公网入口：`https://staging-api.dxerp.org.cn/acceptance/`；
- API 本机端口：`127.0.0.1:3202`；
- PostgreSQL：独立 `dx_rework_acceptance`；
- 旧运行目录：`/opt/dx-rework/acceptance/source`；
- 旧 PM2 进程：`dx-rework-acceptance-api`，历史上由 root 启动；
- Nginx 已有独立 `/acceptance/**` locations；
- 正式生产 API 保持 `127.0.0.1:3201`，不属于本次收口范围。

## 本次 ENV-01 目标

保留既有公网路径和独立 Acceptance 数据库，把运行时迁移到当前发布底座：

- canonical root：`/opt/dx-rework-acceptance`；
- API：`127.0.0.1:3202`；
- frontend：`/opt/dx-rework-acceptance/frontend/current`；
- `APP_BASE_PATH=/acceptance/`；
- `NODE_ENV=test`、`ROOT_DINGTALK_USER_ID=uat-root`；
- 外部 Todo、OSS、OpenAI 写通道关闭；
- GitHub protected environment：`dx-rework-acceptance`；
- routine release 不改 Nginx；Nginx 只在首次切换 canonical root 时做一次受控变更。

## 首次切换必须满足

1. 先备份现有 Acceptance 数据库；不读取或复制生产数据库。
2. 新建低权限 Acceptance 部署用户和 canonical root，不能继续用 root 跑 API。
3. 轮换旧 Acceptance 数据库密码、session secret 和 Acceptance Lab secret；真实值不得进入仓库、日志或聊天。
4. 首次 deploy 使用精确候选 SHA，并显式允许 Acceptance 数据库 pending migrations。
5. 新 API 通过本机 ready/version 后，再把 Nginx 的前端 alias 从旧 `/opt/dx-rework/acceptance/source/apps/web/dist` 切到 canonical frontend。
6. `nginx -t` 成功后才能 graceful reload；不得修改生产 `dxerp.org.cn` vhost、3201、生产数据库或正式附件资源。
7. 公网 `/acceptance/api/health/ready`、`/acceptance/api/version` 和 `/acceptance/ui/acceptance-lab` 全部通过后，才算 ENV-01 运行时落地。
8. 浏览器角色矩阵、Root业务页、生产管理座舱截图和 exact-SHA evidence 全部产生后，才算 Acceptance 可用于正式 P01 施工。

## 不做

- 不创建第二个公开域名；
- 不复用生产数据库；
- 不打开真实钉钉通知；
- 不迁移历史正式订单；
- 不把旧 Acceptance 的 root PM2 进程当作最终运行形态。
