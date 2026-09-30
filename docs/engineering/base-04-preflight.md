# BASE-04 施工预检记录

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 1a5ebe1278cced6c270e1178660c338b69790bce
working branch: codex/create-draft-pr-for-base-04-pipeline（GitHub Draft PR #7）
task scope: 为 apps/web 增加按精确 PR Head 构建、校验、评论及可选安全 ECS 发布/清理的预览验收流水线
allowed files: docs/plan/pr-roadmap-v2.0.md、.github/workflows/pr-preview.yml、apps/web 的最小 base path 适配、scripts/preview/**、tests/unit/pr-preview.test.ts、docs/operations/pr-preview.md、infra/nginx/pr-preview.conf.example、必要 package script 与本记录
forbidden files: 业务 migration、业务规则/审批权限/集体计件算法、Figma/既有视觉 token、钉钉配置、ERP/生产数据与配置、无关依赖和无关文件
```

GitHub PR #7 的 base/head 元数据是最终证据来源。BASE-04 只修改上列文件；任何测试或描述中的 Head SHA 都必须在最终推送后重新读取 PR `headRefOid`，不得沿用 Codex 临时工作区 SHA。
