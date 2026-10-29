# 同厂调价批准后的剩余发厂（PR1）

## 开工边界

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `release/digital-production-v1`
- base SHA: `739d0519bc47cf97c83cf284756c60e38cea2e78`
- base tree: `f428f6faf92ee69c745a48b14acc2bed1dd1e845`
- main SHA（只读核验）: `67841e105fe7090e219477171d3cf79565719241`
- working branch: `fix/acceptance-price-approval-dispatch-pr1-20261029`
- gate class: FULL（单价、合同、审批、跨模块派单）
- task scope: 使合法生效的同厂价格申请继续被数字产前/发厂读取，剩余实发复用原生产执行。
- allowed files: 对应审批读取、数字发厂适配、其必要读取消费者、定向测试及本记录。
- forbidden files: 迁移及 checksum、权限/批准写入规则、部署/PM2、客户日期和时间输入、返工轮次/附件、物流范围、其它 PR 的功能。

依据 `docs/requirements/sourcing-supplier-production-v1.0.md` 的独立价格重新申请规则：涨价走原老板审批，降价直接生效；相同价格不创建新申请/新合同。价格动作不变更工厂、数量或已派单时间，独立回签周期继续沿原规则执行，财务核对不是发厂门禁。

## 入口与消费者清单

| 链路 | 基线行为 / 本次责任 |
| --- | --- |
| `SourcingService.requestPriceReapplication` / `decidePriceReapplication` | 写 approved review、price_reapplication decision、approval snapshot、新合同；原权限/金额/同厂/并发守卫保留，不改写入实现。 |
| `BulkPreparationService.gates` | 原过滤只认普通 owner decision 或 factory_change。补认可与当前 decision、基准 decision、snapshot 同事件的 approved price review；pending/rejected 不可冒充生效批准。 |
| `FactoryFlowService.state/read/batchDispatch` | 消费当前合法 snapshot 取得 supplier 和 ready 合同；原数量、QC、实裁、仓库角色、业务时间、版本及幂等守卫保留。 |
| `SourcingProductionService.dispatchDigitalWithClient` | 剩余物理批次不能按新合同重建执行。只复用同 case、同母单既有 production child，要求当前合同仍 ready；原生产快照/行/transition/派单起点不可改写。普通派单入口的不同合同重复派单拒绝保持。 |
| `DigitalJourneyQuery` 产前 IE/总监/老板节点 | 价格动作是独立动作，不应使原 IE 报价消失或用价格审批人伪装原选厂总监。沿已批准价格的基准链取原选厂阶段证据，仍以当前合法批准决定发厂可用性。 |
| Cutting / ProductionReporting / ProductionDashboard | 读取既有原生产/工厂执行身份，不以 finance reconciliation 或新回签完成作为发厂条件；定向验证页面读取及既有变厂回归，不改数量及执行模型。 |
| 合同首次 ready / 独立回签周期 | 首次业务 ready 与已打开仓库窗口不重启；新价格合同产生独立回签周期，不继承旧回传。原实现保留并回归。 |

## 验证矩阵与状态

全部测试只使用独立 PostgreSQL 随机 schema，正式迁移初始化、低权限测试角色、真实服务命令，不关闭 trigger、不改现场数据。Node 22.22.2 / npm 10.9.9；隔离 PG13.23 与 PG16.15。

- 基线红测：5 项，1 通过 / 4 失败。涨价批准和降价生效后 `ownerApproved=false`；平价用例初版预期错误，已据原实现纠正为 no-op，不能算业务缺陷。
- 覆盖目标：涨价待审及非老板拒绝；批准涨价/直接降价/平价；部分发厂后继续剩余量；同 key 重试；不同 key 同版本并发只提交一次；失败整事务回滚及原 key 重试；当前合同未 ready 不可发厂；新独立回签周期与首次 ready 不变；原 IE/选厂历史；原生产页面与变厂路径；普通派单重复保护。
- PG13.23：新用例 8 + 原业务锚点 19 + 原合同回签 20 = **47/47 通过**。
- PG16.15：新用例 8 + 原外发全套 140 = **148/148 通过**。包含原普通派单、选厂变更、价格重新申请、合同和数字分批发厂断言。
- 全单测 **2579/2579（486 文件）通过**；全工作区类型检查、lint、API 构建、`git diff --check`、secret scan 均通过。
- 实际命令：Node22 执行 `node_modules/vitest/vitest.mjs run <上述套件> --config vitest.business-chain.config.ts --fileParallelism=false --maxWorkers=1`；隔离目标经 `assertTestDatabaseTarget` 核验。普通类型/lint/API build 走原 npm 入口；单测 `vitest run tests/unit --maxWorkers=2`。
- 对 `journey-query.ts` 的修改被原 risk-map 归为 `journeyPg13Compat=true`，映射原 `digital-journey-postgres.test.ts` 与新 suite；不改 risk-map 或门禁。原 journey 套件使用原命令 `vitest run tests/integration/digital-journey-postgres.test.ts --maxWorkers=2`，PG13.23 / PG16.15 **各 26/26 通过**。本轮 PG 总执行计数分别为 **73/73、174/174**，不把跨版本重复执行算成不同业务场景。

## 推送前独立审查及工具失败边界

2026-10-29 14:14 UTC 首次 `codex review --uncommitted` 因工具状态目录只读，在初始化阶段失败。仅申请原工具状态目录写权限后，同一入口在 14:15 UTC 返回 HTTP401，明确要求重新登录；未产生审查结论。CLI 输出的默认配置是 `gpt-6-astra / effort none`，也不符合本任务所要求的设置；没有覆盖配置、替换 token 或改用另一身份。该尝试已退出，不能当作有效审查，更不能当 GitHub approval。

父窗口随后完成独立只读静态审查，核对完整 diff 与739d相关基线；覆盖批准事件/基准快照、待审和批准、降价和平价、ready合同、同母单复用/原数量历史、连续调价与转厂锁、权限及财务非发厂门禁，未发现可确认的 P0–P2 缺陷。该结论仅完成本次推送前质量检查，不能声称 CLI review 成功，也不是 GitHub approval，不能扩大原自动化测试或现场验证的覆盖范围。

父窗口据此明确恢复本 PR 的提交、一次初始推送与 draft PR 流程。现行 FULL 最终 Gate 仍要求 GitHub Codex 的真实回执，必须等轻检查和 GitHub Review、集中修复完成后才显式请求；推送前静态审查不能替代它。CLI认证、模型与Fast配置均未修改。该 PR 禁止 approval、合并、部署或提前施工 PR2。

## 现场边界

现场缺陷单 `7a2c8056-8dd2-4b60-b9a2-da33d29e29ee` / case `196dcf91-ddd3-4965-a378-5f5116c2a011` 保持不动。本地新建 10 件 fixture 的 4+6 分批不冒充现场 4 件 2+2 的补验；线上无自动审批、无回写、无重新发厂。该 PR 不合 main、不部署、不合并。
