# SLA RP6：生命周期场景与边界预览

依据已审核 `SLA_14_Issues_Repair_Construction_Plan_v1_20261117.md` Library 版本 1 的 FIX09、FIX13。目标 `release/digital-production-v1`，初始实际 base `ba2f72fc78672a7d9b64c509012479be425b6213`，独立分支 `fix/sla-rp6-clock-scope-preview`。用户授权在 RP1 等待 CI 时施工下一项，保持独立工作区、必要审查和最终准确提交验证；不部署或执行现场动作，不采用 CI B，不改暂停的首页进度条。

## 写读边界

- `clockLifecycleRoots` 仅被已知 `/digital-production/lifecycle/:kind/:resourceId` 路由调用，按允许的 source/order 类型和原生 UUID 解析；真实类型不符拒绝。没有把任意 body 的 resourceId 加到全局白名单，也不靠款号或标签猜场景。
- 原 `registerAcceptanceClockHooks` 继续核真实控制／业务身份、UAT、场景归属、跨场景和普通资源混用及场景锁，再由已有 `withAcceptanceBusinessTime` 注入。原 `controlResource` 继续消费 `businessNow`；OS、登记审计、生产环境和其他场景的时间不变。无场景走原真实时间；生产根本不安装该 hook。
- `AcceptanceClockPanel` 不再将 `exclusive=true` 解释为预览时刻已逾期，仅显示“日期截止采用排他边界”。预览的服务端 at/token/version、前进限制与提交守卫不变；没有从浏览器当前日期或下拉重算状态。日期 B−1ms 与 B／B+1ms、普通小时 D 的包含规则继续按原算法分别判断。
- 原错误取消历史不回写，不重取消；原固定时钟跨终止后的监督评价是 RP2 的范围，本 PR 不声称已修。

## 最小证据

Node 22.22.2、npm 10.9.9、PG 16.16，新鲜低权限、有安全标记的精确归属容器，原 Vitest 预算及 worker；未连接 Acceptance 或生产。

1. 原认证控制与业务 session、原生命周期 HTTP 路由，source/order 各验证 pause→resume→cancel；业务 occurredAt 精确为场景 `2035-04-05T16:00:00.123Z`，recordedAt 在真实请求起止之间。跨场景、错 kind、请求中混入另一场景 ID 在写前拒绝。场景前进后原事件逐行不变。
2. 无场景的普通 source，在装有和未装有 Acceptance hook 的服务器分别验证真实发生／登记时刻，响应不标测试时钟。工程单测覆盖 arbitrary resourceId 不被全局采纳、类型/UUID拒绝和普通资源解析。
3. 原真实组件、确定性 API 响应的浏览器检查覆盖 1440 与 390 宽度、B−1ms/B/B+1ms，毫秒展示与排他说明均准确，不显示“此刻已越过”；保留未保存业务输入、旧预览冲突和原场景创建幂等保护。这是组件回归，不冒充已部署原 App 或 Root 现场验收。
4. 原时钟 PG 文件最终 30 通过、1 个原有条件浏览器用例未运行；相关单测、API/web 类型及 lint 沿当前 construction 记录。原有完整 App 浏览器需它自己的本地 Vite 环境变量，本次组件检查与真实认证 HTTP 不能冒充该条件用例已运行。

## 原 fixture 失败与处置

首轮完整时钟 PG 为 24 过、4 失败、1 条件未运行；四项均在 owner 日期审批前的 `customerQuotationFixture`，报报价版本更新，尚未到此次生命周期路径。精确 ba2f72fc 新鲜隔离库的四项最小对照同样失败。

`acceptance-sourcing-approval-fixture.ts` 本来显式调用原手工报价命令，但 `initialDevelopmentDocument()` 现在默认 automatic_v1，提前生成了自动报价，违反它的手工版本 0 前提。仅该 fixture 显式去掉自动模式，保留原手工报价前提与全部原审批／改期／回滚断言；未改报价业务服务、版本守卫、一般 helper 或自动报价的专门测试。四项定向复验通过，再完成整文件回归。

本地最初组件启动的 CJS 入口错误与标签选择器错误、订单 fixture 误用未发布来源而被原守卫拒绝，均保留失败日志并更正测试调用，未放宽产品或业务断言。另有磁盘空间不足在新检查开始前阻断；仅移除本轮已完成且干净的临时检出，代码、原始结果及旧 CI 实验均保留。

原始报告位于 `/workspace/sla-rp6-20261117/`；准确命令、指纹和日志摘要见当前 `construction-evidence.json`。实际 PR、Light、Review、Full、合并及现场验收分别记录，不预填后续门禁成功。RP1 合入造成 base 漂移时，先对齐实际合并基线并验证准确最终候选，不把旧 base 的回执当最终结果。
