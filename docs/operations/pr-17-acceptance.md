# PR-17 验收执行规范

`pr-17-acceptance-matrix.json` 是 UAT-01—UAT-22 的唯一证据索引。A 阶段全部保持 `not_run`，不得把自动化测试冒充业务验收。执行仅可在获批隔离环境进行，精确记录环境、Head SHA、schema、脱敏测试数据 ID、角色、步骤、预期/实际、证据、缺陷、执行人和独立复核人。`passed` 必须有证据且执行/复核不能是同一人；失败或阻塞不得降级为成功。

每轮执行前后运行：`node scripts/acceptance/validate.mjs docs/operations/pr-17-acceptance-matrix.json`。截图、日志和导出存入受控证据库，JSON 仅保存引用，严禁 secret、数据库 URL、实名稳定 ID。
