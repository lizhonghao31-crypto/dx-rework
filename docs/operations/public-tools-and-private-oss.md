# 公共 Tools 与私有 OSS 配置边界

## 范围

PR-03 只提供附件、幂等、追加事件、消息 outbox 与导出任务的技术契约，不发送钉钉消息、不生成业务 Excel，也不定义返工、工资或审批字段。所有 actor 均来自服务端 session；HTTP 请求不能提交 `uploadedBy`、actor 或 role。

## 环境变量（仅变量名，不在仓库填写真实值）

- `OSS_REGION`、`OSS_ENDPOINT`、`OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`
- `OSS_PRIVATE_PREFIX`（默认 `dx-rework/private`，必须是独立私有前缀）
- `OSS_SIGNED_URL_TTL_SECONDS`（60–900 秒，默认 300 秒）
- `OSS_MAX_UPLOAD_BYTES`（默认 20 MiB，上限配置不得超过 100 MiB）

前五项必须全部配置或全部省略。省略时服务继续启动，但附件对象操作明确返回 `503 STORAGE_UNAVAILABLE`；部分配置会在启动配置校验时失败。正式联调须使用私有 bucket、最小权限 RAM 身份、HTTPS endpoint，并注入官方维护的 Aliyun OSS SDK client。当前仓库不含 credential，不宣称真实 OSS 已连通。

## 上传与下载安全边界

1. 服务端校验 JPEG、PNG、WebP、PDF 的 MIME、扩展名和配置大小上限；扩展名只用于一致性检查，不能替代 MIME/HEAD 校验。
2. objectKey 使用独立私有 prefix、日期目录和 192-bit 随机值；不包含原文件名，不保存公开 URL。
3. 上传意图只返回短时签名 PUT。PUT 必须带服务端约定的 Content-Type、SHA-256 metadata 和 private ACL。
4. finalize 通过服务端 HEAD 验证对象存在、实际大小、MIME，并在 metadata 可用时验证 SHA-256；不一致会拒绝，不能进入 ready。
5. 下载只返回短时签名 GET。当前路由只允许上传者；未来业务对象必须通过显式授权决策传入 service，不能仅凭 attachmentId 下载。

## outbox、失败与重试

业务服务应在同一个 PostgreSQL transaction/client 中写业务记录、`operation_events` 和 `message_outbox`。worker 使用 `FOR UPDATE SKIP LOCKED` 领取；领取后成功转 `sent`，失败保存最长 500 字符的脱敏错误并将 `availableAt` 推迟后重试。唯一键 `(topic, recipientKey, idempotencyKey)` 防止重复待办。本 PR 不包含消息发送 worker。

导出任务使用相同的 `SKIP LOCKED` 模式从 pending 进入 running；成功结果必须引用 ready attachment，失败只保存脱敏错误。本 PR 不生成 Excel。

## 联调条件与已知风险

- bucket 必须验证为 private，并完成 PUT/HEAD/GET 签名 TTL、metadata、跨网 endpoint 与时钟偏差测试。
- OSS 生命周期、病毒扫描、孤立 pending 对象清理及业务附件保留策略留待对应业务/运维 PR 定稿。
- SHA-256 metadata 可能因上传代理或 SDK 行为缺失；缺失时仍验证 size/MIME，生产联调应确认强制 metadata 策略。
- 回滚方式是回滚应用提交；migration 0004 为追加迁移，不应直接 DROP。停用新路由后保留表和私有对象，后续通过单独审批的数据迁移处理。
