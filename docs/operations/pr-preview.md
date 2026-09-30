# BASE-04 PR 自动预览运维手册

预览只展示当前仓库 `apps/web` 的静态构建产物，固定路径 `/pr-<number>/`，远端活动目录仅为 `/opt/dx-rework/previews/pr-<number>`。它不连接 API、ERP、钉钉、生产数据库或附件，也不授权本 PR 修改 ECS、Nginx、DNS、TLS 或 GitHub 配置。

## 管理员一次性配置

1. 建立独立低权限 ECS 用户，仅允许写 `/opt/dx-rework/previews`；不得加入生产应用组，不得访问 `/opt/daxing-erp`、数据库或附件目录。预建真实目录（不可为软链接），并以该用户为 owner。
2. 配置独立验收域名与 TLS，安装 `infra/nginx/pr-preview.conf.example` 为独立 vhost；先执行 `nginx -t`，再在维护窗口 reload。只允许 GET/HEAD，禁止目录索引和软链接，并保持 `noindex`。
3. GitHub Variables：`PR_PREVIEW_ENABLED`（默认不设或 `false`）、`PR_PREVIEW_HOST`（SSH 主机名）、`PR_PREVIEW_ORIGIN`（仅含 origin 的 HTTPS 地址）。
4. GitHub Environment `pr-preview` Secrets：`PR_PREVIEW_SSH_USER`、`PR_PREVIEW_SSH_KEY`、`PR_PREVIEW_SSH_HOST_KEY`。只放专用用户和固定 host key，不记录真实值、IP 或账号到仓库。
5. 完成隔离、权限、TLS、路径与软链接拒绝 smoke test 后，才把 `PR_PREVIEW_ENABLED` 设为 `true`。停用时改为 `false`；流水线仍构建、校验并上传 artifact，但评论明确显示“部署未启用”，不会伪造 URL。

### Codex Environment 提速设置（外部一次性设置）

当前仓库没有可安全声明 Codex 云端自动准备步骤的官方仓库配置文件，因此不要新增臆造配置。请在该仓库对应的 Codex Environment 设置中：

- 运行时固定为 `.nvmrc` 的 Node `22.22.2`；npm 固定为 `10.9.9`。
- Setup script 只在 monorepo 根目录执行一次：`npm install --global npm@10.9.9 && npm ci`。
- 删除逐个 workspace 的 `npm install`，也不要在它们之后再次执行根目录安装。
- 保存后用 `node --version`、`npm --version`、`npm prefix` 验证应分别为 `v22.22.2`、`10.9.9` 和仓库根目录；再执行 `npm run typecheck` 作为 smoke test。

## 日常使用

开发者只需更新 PR。流水线按精确 Head SHA 构建，生成 manifest、Run ID、checksum 和直达 fallback，并以稳定 marker 更新同一条评论。启用部署后，验收人只打开评论中的真实入口；未启用时下载 Actions artifact。

每次部署先上传到 Head 专属随机 staging 目录，再次读取 GitHub 当前 PR Head 后才允许激活。远端在 PR 级锁内比较单调递增的 GitHub Run ID：旧 Run 即使未及时取消，也不能覆盖新 Run。活动目录与 staging 均拒绝软链接、路径穿越和不匹配的 manifest。部署失败会明确显示“部署失败”并保持检查失败，不会误报为“未启用”。

## 关闭、风险与回滚

PR 关闭后，流水线在删除前后都校验 PR 仍为 closed 且 Head 未变化；远端同时校验活动目录 generation marker 的 Head 和 Run ID。PR 已重新打开、Head 已改变或已有更新 generation 时拒绝清理。清理失败会写明“清理失败”并保持检查失败。

主要风险是错误权限、错误 vhost 或凭据范围过大；用专用用户、固定 host key、只读 HTTP、无软链接和严格路径校验降低风险。紧急停用：先将 `PR_PREVIEW_ENABLED=false`，再停用独立 vhost；不影响主应用。整体回滚为 revert BASE-04 commit，并移除独立 vhost/专用凭据；不得触碰 ERP 或生产 current。
