# BASE-04 PR 自动预览运维手册

预览只展示当前仓库 `apps/web` 的静态构建产物，固定路径 `/pr-<number>/`，远端根目录仅为 `/opt/dx-rework/previews/pr-<number>/`。它不连接 API、ERP、钉钉、生产数据库或附件，也不授权本 PR 修改 ECS、Nginx、DNS、TLS 或 GitHub 配置。

## 管理员一次性配置

1. 建立独立低权限 ECS 用户，仅允许写 `/opt/dx-rework/previews`；不得加入生产应用组，不得访问 `/opt/daxing-erp`、数据库或附件目录。预建真实目录（不可为软链接），并以该用户为 owner。
2. 配置独立验收域名与 TLS，安装 `infra/nginx/pr-preview.conf.example` 为独立 vhost；先执行 `nginx -t`，再在维护窗口 reload。只允许 GET/HEAD，禁止目录索引，并保持 `noindex`。
3. GitHub Variables：`PR_PREVIEW_ENABLED`（默认不设或 `false`）、`PR_PREVIEW_HOST`（SSH 主机名）、`PR_PREVIEW_ORIGIN`（HTTPS origin）。
4. GitHub Environment `pr-preview` Secrets：`PR_PREVIEW_SSH_USER`、`PR_PREVIEW_SSH_KEY`、`PR_PREVIEW_SSH_HOST_KEY`。只放专用用户和固定 host key，不记录真实值、IP 或账号到仓库。
5. 完成隔离、权限、TLS 与路径 smoke test 后才把 `PR_PREVIEW_ENABLED` 设为 `true`。停用时改为 `false`；流水线仍构建、校验并上传 artifact，但评论明确显示“部署未启用”，不会伪造 URL。

## 日常使用

开发者只需更新 PR。流水线按精确 Head SHA 构建、生成 manifest/checksum 和直达 fallback，并以稳定 marker 更新同一条评论。启用部署后，验收人只打开评论中的真实入口；未启用时使用 Actions artifact。新 Head 会取消旧运行，评论前再次读取 GitHub 当前 Head，旧结果不会覆盖新结果。PR 关闭后，仅删除对应的严格校验目录并更新评论为“清理完成”。

## 风险、回滚与清理

主要风险是错误权限、错误 vhost 或凭据范围过大；用专用用户、固定 host key、只读 HTTP 和严格路径校验降低风险。紧急停用：先将 `PR_PREVIEW_ENABLED=false`，再停用独立 vhost；不影响主应用。单 PR 一键清理：在受控 ECS 上执行 `bash scripts/preview/remote-cleanup.sh <PR号>` 的已审查副本；脚本拒绝空值、通配符、根目录和非 `pr-[0-9]+` 目标。整体回滚为 revert BASE-04 commit，并移除独立 vhost/专用凭据；不得触碰 ERP 或生产 current。
