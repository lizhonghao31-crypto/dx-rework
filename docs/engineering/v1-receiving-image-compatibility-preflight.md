# 仓库收货图片兼容：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: c564feca79d28f4230b3b7e8d9a2d5dc36874cfd
working branch: fix/receiving-image-normalization
task scope: 仅修复仓库收货对微信保存图片的兼容与中文错误提示
allowed files: apps/web/src/attachment-upload.ts；apps/web/src/receiving-page.tsx；tests/unit/receiving-image-upload.test.ts；本预检与对应需求文档
forbidden files: API校验、数据库迁移、其他业务页面、权限、工作流与配置
```

本 PR 保留普通图片的现有快速路径，只在非标准相册图片或服务端内容校验失败时执行收货专用标准化。

