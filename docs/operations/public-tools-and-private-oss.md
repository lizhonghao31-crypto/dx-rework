# 公共 Tools 与私有 OSS 配置边界

## 范围

PR-03 只提供附件、幂等、追加事件、消息 outbox 与导出任务的技术契约，不发送钉钉消息、不生成业务 Excel，也不定义返工、工资或审批字段。所有 actor 均来自服务端 session；HTTP 请求不能提交 `uploadedBy`、actor 或 role。审计分别保存认证得到的业务角色快照与本次授权 capability，绝不把 capability 伪装成业务角色。所有 Tools 路由明确要求 `tools:user` capability 和非空的可信业务角色快照；PR-04 角色源接入前真实请求会 fail closed 为 `403 NO_BUSINESS_ROLE`，其他业务 capability 不能替代。

## 环境变量（仅变量名，不在仓库填写真实值）

- `OSS_REGION`、`OSS_ENDPOINT`、`OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`
- `OSS_PRIVATE_PREFIX`（默认 `dx-rework/private`，必须是非根、无首尾斜杠和空路径段的独立私有前缀）
- `OSS_SIGNED_URL_TTL_SECONDS`（60–900 秒，默认 300 秒）
- `OSS_MAX_UPLOAD_BYTES`（默认 20 MiB，上限配置不得超过 100 MiB）

前五项必须全部配置或全部省略。省略时服务继续启动，但附件对象操作明确返回 `503 STORAGE_UNAVAILABLE`；部分配置会在启动配置校验时失败。生产配置强制 HTTPS endpoint，并拒绝占位 AccessKey。正式联调须使用私有 bucket、最小权限 RAM 身份，并注入官方维护的 Aliyun OSS SDK client。当前仓库不含 credential，不宣称真实 OSS 已连通。

## 上传与下载安全边界

1. 服务端校验 JPEG、PNG、WebP、PDF 的 MIME、扩展名和配置大小上限；扩展名只用于一致性检查，不能替代对象 metadata/HEAD 校验。
2. objectKey 使用独立私有 prefix、日期目录和 192-bit 随机值；不包含原文件名，不保存公开 URL。
3. 上传意图返回短时签名 `POST` endpoint、固定表单字段及精确过期时间。客户端必须原样附带服务端返回的字段，并把 `file` 作为最后一个表单字段。
4. Post Policy 必须把 `key`、`Content-Type`、`x-oss-meta-sha256`、private ACL、`x-oss-forbid-overwrite=true` 和成功状态绑定为精确值，并使用 `content-length-range` 将最小值和最大值都设为本次 intent 的 `sizeBytes`。这样超出或小于声明大小的对象会在 OSS 接收前被拒绝，而不是上传后才浪费带宽与存储。
5. 承载该前缀的 bucket 必须关闭或从未启用 versioning；versioning enabled/suspended 时，OSS 可能忽略防覆盖语义。浏览器 CORS 只允许已批准应用源和所需的 POST/GET/HEAD，不允许通配源。
6. finalize 先通过服务端 HEAD 验证对象存在、实际大小、MIME 和必需 SHA-256 metadata，再由服务端流式读取私有对象并计算真实字节的 SHA-256；只有实际 digest 与 intent 一致才可进入 ready。客户端自报 metadata 不是内容完整性的信任根。任一缺失或不一致都会拒绝；`ready` 的重复 finalize 按幂等读取处理。
7. 下载只返回短时签名 GET，响应中的过期时间直接沿用存储 grant，并按 SDK 的整秒签名时钟向下取整，不能在签名完成后重新计算。每次成功签发下载 grant 都以可信 actor 角色与授权 capability 写入追加审计，但不记录签名 URL。除上传者外，只有申请人可访问绑定到其 export job 的 ready 结果附件；其他业务对象必须通过显式授权决策传入 service，不能仅凭 attachmentId 下载。

官方实现应使用 `ali-oss` 的 `signPostObjectPolicyV4` 生成 Post Policy，不在业务代码手写签名算法。参考：[服务端签名后直传 OSS](https://www.alibabacloud.com/help/en/oss/user-guide/obtain-signature-information-from-the-server-and-upload-data-to-oss)、[Post Policy 条件](https://www.alibabacloud.com/help/en/oss/policies-for-setting-post-requests-in-oss)和 [PostObject 请求字段](https://www.alibabacloud.com/help/en/oss/developer-reference/postobject)。

## outbox、失败与重试

业务服务应在同一个 PostgreSQL transaction/client 中写业务记录、`operation_events` 和 `message_outbox`。worker 使用 `FOR UPDATE SKIP LOCKED` 领取；默认 lease 为 300 秒（允许 30–3600 秒），超时的 `processing` 记录可被重新领取。每次领取生成新的 `claimToken`，只有持有当前 token 的 worker 才能确认成功或失败，过期 worker 不能覆盖新 owner。领取后成功转 `sent`，失败只保存固定、无凭据的安全错误分类，并将 `availableAt` 推迟 1–86400 秒后重试；完整诊断仅进入受控服务端遥测。唯一键 `(topic, recipientKey, idempotencyKey)` 仅在 aggregate 与 payload 语义相同时复用，否则返回 409。本 PR 不包含消息发送 worker。

导出任务使用相同的 `SKIP LOCKED`、`claimToken` 与 300 秒默认 lease（允许 30–3600 秒）；超时的 running 任务可重新领取，但旧 worker 不能完成或失败新 lease。相同幂等键仅在 filters 相同时复用。幂等请求每次 acquisition 也有独立 token，过期接管后旧请求不能写入新 owner 的响应。成功结果必须引用 ready attachment，失败只保存脱敏错误。本 PR 不生成 Excel。Aliyun SDK 尚未装配时存储实现继续 fail-fast/返回明确 503，不会伪装成已联通。

数据库约束同时保护状态一致性：追加审计禁止 UPDATE、DELETE 和 TRUNCATE；processing/running 必须同时持有 claim token 与领取时间；ready/rejected/succeeded/failed 必须带齐对应时间或原因字段。应用层检查不是这些不变量的唯一防线。

## 联调条件与已知风险

- bucket 必须验证为 private、versioning disabled，并完成重复上传拒绝、超限/不足大小拒绝、POST/HEAD/GET grant TTL、metadata、跨网 endpoint 与时钟偏差测试。
- OSS 生命周期、病毒扫描、文件魔数/内容扫描、孤立 pending 对象清理及业务附件保留策略留待对应业务/运维 PR 定稿；在这些扫描接入前，业务层不得把附件内容本身视为可信输入。
- 回滚方式是回滚应用提交；migration 0004 为追加迁移，不应直接 DROP。停用新路由后保留表和私有对象，后续通过单独审批的数据迁移处理。
