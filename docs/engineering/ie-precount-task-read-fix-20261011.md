# IE 预核任务读取阻断修复

普通 IE 在 N03 核价通过后进入 N04，页面请求执行任务列表，却收到 403 并显示“暂无返工任务”。09fbd674bf51 与 release/digital-production-v1 的 d4f3cc95667ea82bbcf6c6559090f2da4577590e 均存在该问题。

前端 `canUseWorkWorkspace` 接受 `ie_reviewer + process:review`，报数节点传入 IE 预核资料，`WorkReportingForm` 因此请求 `GET /rework-orders/:id/work-tasks`。后端路由没有 IE 读取分支；服务的任务列表和单个任务 DTO 也没有 IE 只读路径。Root 已有专门读取路径，因此不能用 Root 成功代替普通 IE 验收。

本次仅补齐 IE 角色且具有 `process:review` 时的执行任务只读路径。保留真实角色和 capability，不添加尾部主管角色、不赋予 `work:assign`、`work:report` 或 `work:report_for_worker`。分配、员工调整、执行报数和 IE 预核写入规则均不修改；无前端、migration、部署、依赖或真实业务数据变更。

## 验证

- 用旧版后端运行新增回归：HTTP 读取返回 403；真实 PostgreSQL 服务读取在任务列表过滤处返回 403。
- 修复后定向测试：路由允许普通 IE 和 Root 读取；缺少 IE 角色或核价 capability 时拒绝；普通 IE 分配、执行报数、员工调整返回 403。
- 独立 loopback TEST PostgreSQL 中按现有完整 migration 建立随机隔离 schema，正规 N03 核价与任务激活后，普通 IE 可读取返工和整查两种任务，全部 `canSubmitReport=false`。N04 和 N05 状态下均能记录预核并读回，缺少 capability 的服务读取仍拒绝。保留 Root 实际执行回归。
- API 类型检查、构建和改动文件 lint 通过；Full Gate 与 Codex Review 以 PR 当前 Head 的结果为准。

## 后续浏览器回归范围

部署仍由业务负责人执行。旧 TEST 订单可在部署后以普通 IE 身份核查 N04：任务不再误报为空，工序行出现既有 IE 预核入口，保存后能读回；不可出现执行报数、分配或员工调整权限。本文不记录该订单的线上写入或浏览器验收成功。

后端允许 `in_progress` / `pending_order_review`（N04/N05）预核。当前详情页只在 `work_reporting` 节点挂载可编辑 `IePrecountCell`；N05 `whole_order_review` 不传该编辑控件。后端允许 N05 不等于 N05 页面已有编辑入口，这个既有差异不在本次 N04 读取阻断修复中改变。
