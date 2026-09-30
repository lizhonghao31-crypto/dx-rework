# Root UAT PR-02 附件真实性与孤儿治理预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: c4004f380bcc5e5b71831d6ac4aa1642595d5061
working branch: fix/v1-root-uat-attachment-integrity
task scope: 校验附件真实字节并安全清理过期且未绑定的附件，不改变现有上传交互
allowed files: docs/engineering/v1-root-uat-pr-02-attachment-integrity-preflight.md; docs/requirements/v1-root-uat-attachment-integrity-2026-08-25.md; apps/api/src/tools/attachments.ts; apps/api/src/tools/file-content-validation.ts; apps/api/src/tools/storage.ts; apps/api/src/tools/aliyun-oss-v4-client.ts; apps/api/src/server.ts; tests/unit/attachment-service-failures.test.ts; tests/unit/file-content-validation.test.ts; tests/unit/aliyun-oss-v4-client.test.ts; tests/unit/public-tools.test.ts
forbidden files: apps/web/**; apps/api/src/rework/**; apps/api/src/receiving/**; apps/api/migrations/**; packages/contracts/**; packages/config/**; .github/**
```

## 施工边界

- 保持上传入口、支持格式、文件数量和页面布局不变。
- 不修改已绑定业务附件，不清理任何带有 `entity_type` 或 `entity_id` 的记录。
- 不引入图片处理依赖、UI组件库、数据库迁移或环境变量。
- 清理任务失败不得阻断 API 启动或正常上传。

## 验收证据

- 定向单元测试：文件内容校验、附件最终确认、OSS读取与删除、孤儿并发保护。
- 当前 intended head 完成 Quick Gate 与 Full Gate 后方可合并。
