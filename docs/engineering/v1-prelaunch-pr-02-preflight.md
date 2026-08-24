# 1.0 上线前 PR-02 施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: d0814510c4f837114dbf68b63384bba499813058
working branch: feat/v1-effective-quantity-review
task scope: N05 / N06 有效数量、主管修正、自动整单确认、IE 只读复核及工资统一取值
allowed files: apps/api/migrations/0087_*.sql; apps/api/src/platform/migration-manifest.json; packages/contracts/src/index.ts; packages/contracts/src/compat-index.ts; apps/api/src/rework/whole-order-review-*.ts; apps/web/src/whole-order-review-panel.tsx; apps/web/src/styles.css; tests directly affected by ReviewWholeOrder/WholeOrderReviewResponse contracts; tests/integration/*whole-order*; tests/integration/root-single-account-two-pass-postgres.test.ts
forbidden files: 历史 migration；Root 特权；责任、老板签字和收货状态机；全局调色板；性能专项
```

业务依据：`尾部返工数字化模块_1.0上线前业务优化_施工方案与PR计划.md` 的 PR-02 规则。

实现约束：原始报数不可覆盖；修正以追加版本保存；N05 按工序强制工人有效合计等于尾查有效合计；最终数量由系统生成；N06 只读；工资与后续数量事实只读有效数量。
