# 施工工作流

现行政策唯一入口为[根 AGENTS.md](../../AGENTS.md)。本文只提供入口顺序，适用于已授权目标分支，不绑定旧 PR 或批次。

1. 核实际远端 base 与有效授权，读相关业务规范，建立变更影响及旧消费者记录。
2. 运行便宜预检和直接受影响的旧新组合；按实际风险验证权限、状态、日期、初始化、资源及 UI。缺项先在本地闭环。
3. 组装完整候选并自查 diff，PR首次创建运行一次Light，再发必要GitHub Codex Review；之后任何变动不重跑Light，最终Quick/Full验证当前版本。
4. 收齐 finding 集中修复，冻结 Head，显式请求最终 Quick 或 Full；不得每项修复都追加完整 Review/Gate。
5. 核完整 Head/base/mode/run/job/attempt 与回执，按已授权范围 expected-Head 合并并核 merge/tree。新 Head/base 变化使旧最终批准失效。

入口：

- [影响与验证证据](construction-evidence-v1.md)：防止只报“已检查”、漏旧消费者或用旧来源结果。
- [最终 Gate 协议](review-first-final-head-20261027.md)：请求、状态核验、Review 恢复及复用来源。
- [Actions 执行边界](github-actions-usage-policy-v1.0.md)：检查与资源的实际执行和复用。

全程接手不重复询问普通已授权步骤；用户停止、真实拒绝或范围变化按 AGENTS 处理。进度报告真实关键路径、全部实质阻断及下一步，不机械按分钟重复打卡。不以 CI/Review/合并/部署中的任一个状态冒充其它状态。
