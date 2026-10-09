# DEF012 财务节点自然日显示修复

## 现象与范围

Acceptance 普通财务总监查看 RW008 财务节点工资明细时，完工日期显示为“2026/10/9 00:00”。`wageSelection` 已按业务时区将真实劳动完成时间取为自然日；财务节点 reader 未将该 date 列转为文本，pg 把它解析成 JavaScript Date，统一序列化再生成 ISO，前端因此按真实时间显示时分。这是既有读取路径问题，不是本次首页改动引入。

用户已授权验收期间同步修复。本次基线为 `release/digital-production-v1` 的 `1b4f181be7f01de967474028386bfb6dc5b341b7`。只修自然日展示，不合入 main，不部署，不改业务时间值、金额、权限、state、数据库结构、迁移或依赖。

## 修复

- 财务节点工资 `completed_date::text`，沿用统一工资报表的自然日文本策略。
- 同 reader 的扣款自然日 `entry.deducted_on::text`。
- `marked_at`、`created_at` 和其他真实时间戳继续走原 Date → ISO，保留时间与毫秒精度。前端已有自然日文本直接显示分支，不需改前端。
- WHERE、参数、工资来源/计算、业务时区截取规则与普通财务权限检查保持原样。

## 回归和证据边界

新增 `tests/unit/finance-node-date-values.test.ts`，调用真实 `readFinanceNode`，使用真实 pg DATE 解析器重现原类型差异；覆盖两个结算节点、自然日字段、NULL、真实 timestamp 毫秒精度、金额/其他列不变和无权限拒绝。查询客户端为明确测试替身，不宣称该单测本身执行了 PostgreSQL SQL。

当前 task 接口不可用且本地无完整 checkout/依赖，移植工具只组装精确范围。push 前用 Node 原生 TypeScript 转换运行实际 reader 的隔离 harness，确认原代码失败、修复通过；schema/import 边界使用测试替身，不能称为完整 Vitest/DB/浏览器验收。

最终新 Head 使用 [FULL] Gate，财务/backend 风险按仓库既有映射触发隔离 PostgreSQL 与工资/业务链回归，不更改任何门禁。Gate 通过后最多一次 GitHub Codex Review。具体证据记录在该 PR。Acceptance 部署后的普通财务真实页面复测另行确认，不把 CI 通过当成人工验收。

## 回滚

revert 本 PR 合并提交；不需数据回滚。本次未执行部署、重启、ECS 或真实数据库操作。
