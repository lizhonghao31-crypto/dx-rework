# N04/N05 IE 预核入口修复

普通 IE 在 N03 核价通过后进入 N04，页面请求执行任务列表，却收到 403 并显示“暂无返工任务”；订单推进 N05 后，普通 IE 和 Root 均没有预核编辑入口。09fbd674bf51 与 release/digital-production-v1 的 d4f3cc95667ea82bbcf6c6559090f2da4577590e 均存在这两个问题。

## 原因与修复

N04 前端 `canUseWorkWorkspace` 接受 `ie_reviewer + process:review`，并传入 IE 预核资料。后端路由、任务列表及单个任务 DTO 未接受 IE 只读，Root 却有专门路径。本次补齐 IE 且具有 `process:review` 的执行事实只读权限，保留真实角色与 capability，不添加尾部主管角色、不赋予执行写能力。任务 DTO 字段不增加，工人用户账号、工资及成员分成不暴露。

N05 后端已允许 `pending_order_review` 记录预核，但详情页没有向 `whole_order_review` 传预核资料，审核面板没有编辑控件。现在向 N05 传递资料，并在现有每道工序区域复用 N04 的 `IePrecountCell`。控件抽到独立文件，避免报数表单与审核面板循环依赖；沿用原样式、数量/备注输入、保存 API、追加记录和审计日志。`canRecord` 与模块可写同时满足才可编辑；历史页与 N06 继续只读。保存后刷新详情并读回最新预核，原记录不覆盖。

N04 仅在返工工序分组挂载预核控件，整查分组继续只读，符合后端只允许 worker 工序记录预核的既有规则。浏览器夹具同时包含返工与整查，入口必须且只能出现一次；未修控件的夹具稳定复现两个入口。

不修改执行报数、任务分配、人员调整、订单状态机、migration、部署或依赖，不新增业务字段。

## 验证

- 旧版后端运行新增回归，HTTP 与服务任务读取分别返回 403；修复后普通 IE 与 Root 可读取，缺少角色或核价 capability 时拒绝。
- 普通 IE 分配、执行报数、员工调整返回 403。
- 独立 loopback TEST PostgreSQL 中按完整 migration 建立随机隔离 schema，正规 N03 核价与任务激活后，IE 可读取返工/整查两种任务，全部 `canSubmitReport=false`，成员仅保留既有 personId/displayName/personType。N04/N05 状态下预核保存读回；尾主管、工人和无 capability 的 IE 写预核均拒绝。Root 可追加 N05 预核，三条记录及不同记录人保留；直接更新日志被数据库拒绝。保留 Root 执行回归。
- 真实 React 详情页离线浏览器回归覆盖 N04/N05、390/1440 宽度、普通 IE/Root/尾主管/只读 IE 共 16 场景。允许角色保存读回且只调用预核写 API、原记录保留；拒绝角色无编辑入口、无写请求。
- 定向测试 5 文件 42 项通过。全量本地检查与 PR Full Gate、Codex Review 分别记录，不替代线上业务验收。

部署仍由业务负责人执行；部署后可使用已保留的 TEST 订单以普通 IE 定点回归。本文不声明已部署或线上验收成功，不记录真实业务写入。
