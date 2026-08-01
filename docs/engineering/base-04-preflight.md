# BASE-04 施工预检记录

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 1a5ebe1278cced6c270e1178660c338b69790bce
working branch: agent/base-04-pr-preview-pipeline（Codex 平台注入 work 分支重命名）
task scope: 为 apps/web 增加按精确 PR Head 构建、校验、评论及可选安全 ECS 发布/清理的预览验收流水线
allowed files: docs/plan/pr-roadmap-v2.0.md、.github/workflows/pr-preview.yml、apps/web 的最小 base path 适配、scripts/preview/**、tests/unit/pr-preview.test.ts、docs/operations/pr-preview.md、infra/nginx/pr-preview.conf.example、必要 package script 与本记录
forbidden files: 业务 migration、业务规则/审批权限/集体计件算法、Figma/既有视觉 token、钉钉配置、ERP/生产数据与配置、无关依赖和无关文件
```

平台工作区没有配置 Git remote 或本地 `main`；注入的干净 `work` HEAD 与任务指定的 PR #6 merge commit 完整 SHA 一致。施工前已完整阅读根 `AGENTS.md`、路线图、需求 v1.2、现有 Actions、web 构建配置和独立运维边界。
