# 1.0 上线前性能 PR-11 预检与证据

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 12af0b83fc53070bb4ac6c97e4270c767b53d9d1
working branch: codex/v1-prelaunch-performance-pr11
task scope: 收敛订单详情与节点工作区的重复读取，并减少详情服务的数据库往返
allowed files: apps/web/src/auth.tsx; apps/web/src/rework-detail-page.tsx; apps/web/src/process-configuration-form.tsx; apps/web/src/process-worker-assignment-form.tsx; apps/web/src/work-reporting-form.tsx; apps/web/src/responsibility-determination-panel.tsx; apps/api/src/rework/rework-business-detail-service.ts; tests/unit/v1-prelaunch-performance-pr11.test.ts; docs/engineering/v1-prelaunch-performance-pr11-preflight.md
forbidden files: migrations/**; CSS/**; contracts/**; workflow state machine; write services; DingTalk provider/outbox; production configuration
```

## 读取扇出证据

施工前订单详情的读取链包含以下重复工作：

- 外层详情：`business-detail` + `auth/me`。
- N02 嵌入工作区：再次读取 `auth/me`、`business-detail`，同时读取工序配置与人员预分配；可编辑时再读取工序和人员选项。
- N04/N05/N06 嵌入工作区：再次读取 `auth/me`，随后读取任务及必要的工序/人员数据。
- N07 嵌入工作区：再次读取 `auth/me`，随后读取责任判定与供应商选项。
- `business-detail` 服务在权限确认后，工资状态与未结工资周期分别查询同一组工资表。

PR-11 将同一浏览器页面内的 `auth/me` 收敛为 PR-10 已验证的单次会话 Promise；N02 嵌入时复用外层详情已经授权并取得的只读事实；服务端工资状态与未结周期合并为一次 CTE 扫描。

## 风险控制

- 独立 N02 页面没有外层详情可复用时，仍按原路径读取 `business-detail`。
- 只复用当前页面已验证身份；所有业务 GET/POST 仍由 API 逐请求授权。
- 不缓存工序、任务、责任、金额、数量或版本数据。
- 不并行执行附件、历史、结算等数据库查询，避免在 2核2G 环境放大连接争用。
- 不增加索引、不改迁移。`operation_events` JSON 历史分支和返工看板大 CTE 必须取得 staging `EXPLAIN (ANALYZE, BUFFERS)` 后再决定索引，不能凭源代码猜测。

## 预期请求变化

- N02 订单详情：减少 2 个重复请求（`auth/me`、`business-detail`）。
- N04/N05/N06：减少 1 个重复 `auth/me` 请求。
- N07：减少 1 个重复 `auth/me` 请求。
- 有工资查看权的 `business-detail`：减少 1 次数据库往返，并只扫描一次工资周期 CTE。

## 回滚

无迁移、无写入合同变更，可回滚单个 squash merge 完整恢复旧读取链。
