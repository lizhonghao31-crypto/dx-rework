# 订单回货深化 PR 预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: eeeebdb930ddff92b1022a63582cf4d462edbe96
working branch: feat/receiving-board-operations
task scope: 订单回货导出、装箱数量、双差异处理、信息布局与四位数历史文本修复
allowed files: apps/api/migrations/0139_*, apps/api/src/receiving/*, apps/web/src/order-board-page.*, tests/*receiving*, docs/architecture/decisions/ADR-0022-*, docs/engineering/receiving-board-operations-preflight.md
forbidden files: 返工状态机与工序上限、报价选厂/合同、跟单/财务权限调整、返工报表状态、部署和 CI 配置
```

- 执行方式：ChatGPT 在独立工作区直接施工；GitHub `main` 和开放 PR 已通过连接器核验。
- 门禁：本 PR 修改数量、权限、审计和数据库结构，必须执行 Full Gate；最终 intended Head 全绿后由业务负责人手动触发一次 Codex Review。
- 交付边界：业务负责人验收并明确通过前不得合并，也不得开始下一张 PR。
