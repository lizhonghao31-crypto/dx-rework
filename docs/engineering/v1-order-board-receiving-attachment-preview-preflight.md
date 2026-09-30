# 收货看板收货单附件预览：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 2069922ed77c4ed66a9261eea35d8b76c2e545c0
working branch: feat/order-board-receiving-attachment-preview
task scope: 在现有“收货单”字段内按需查看该收货批次已上传的图片
allowed files: receiving-service.ts；order-board-page.tsx/css；server.ts中收货批次图片授权分支；对应测试；本预检与需求文档
forbidden files: 新增“送货单”字段、重复上传、数据库迁移、收货/返工业务规则、其他附件类型、工作流与部署配置
```

看板只返回附件ID和文件名；预览或下载时继续走既有鉴权与短期签名链路，不在列表加载图片本体。
