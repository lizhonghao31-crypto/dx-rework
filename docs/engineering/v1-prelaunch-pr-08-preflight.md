# 上线前 1.0 PR-08 施工预检：收货图片确认链路

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `a52655e4f951e6ba131c06271fb3e2750d43eb56`
- branch: `fix/v1-prelaunch-receiving-attachment-finalize`
- objective: 修复收货单图片完成 OSS 直传后，附件 `finalize` 因 HEAD 兼容性或时间字段解码异常返回 500 的问题；保留现有精确大小、MIME 与 SHA 元数据校验。
- allowed files: `apps/api/src/tools/aliyun-oss-v4-client.ts`; `apps/api/src/tools/attachments.ts`; `tests/unit/aliyun-oss-v4-client.test.ts`; `tests/unit/attachment-service-failures.test.ts`; 本预检记录
- forbidden files: `apps/web/**`; `apps/api/migrations/**`; `packages/**`; 收货状态机；责任判定；工资；权限；钉钉；部署配置；生产数据
- verification: 定向单元测试、全量 unit、lint、typecheck、build、migration lint、secret scan、精确 PR Head CI
- rollout boundary: 本 PR 只提交代码与测试，不主动部署生产；合并后由既有 staging 发布链验证真实收货图片。

## 根因与修复边界

1. 浏览器直传已返回成功，故失败点位于服务端 `finalize`。
2. 当前服务只用预签名 `HEAD` 读取 OSS 元数据；部分 OSS/代理组合会拒绝或异常处理 `HEAD`，且没有 GET Range 兼容路径。
3. `AttachmentRow.created_at` 被静态假定为 `Date`；若 PostgreSQL 驱动或代理返回 ISO 字符串，事务已经完成后调用 `toISOString()` 会产生未分类 500。
4. 修复将优先执行 `HEAD`，失败时仅用带 `Range: bytes=0-0` 的签名 GET 读取同一组元数据，并立即取消响应体；同时规范化数据库时间值。不会跳过对象存在性、大小、MIME 或 SHA 元数据校验。
