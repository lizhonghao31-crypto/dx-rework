# Acceptance 首轮场景创建与业务时钟修复

基线：`release/digital-production-v1` @ `9b0a899f748870807fe7c4277568ea30f581dd7f`。
分支：`fix/acceptance-clock-atomic-init-20261026`；Gate：FULL。
只处理已证实的场景权限残留、车板自动激活墙钟混用，以及后续授权并复现的 PO 交期审批共享时钟遗漏；补正误拦截另 PR，不施工 P09/P10。

## 根因及最小修复

1. runtime 先提交 repository 场景，再调用原生 createSource，后者才校验创建开关及原权限。现将原生来源创建权限封装为共享预检，runtime 在任何场景持久化之前调用，createSource 自身仍调用同一规则。普通身份必须 sample_designer 且具 pattern_room:orders:create，Root 原特权保留。没有增加身份或 capability。
2. 原自动首次车板激活把 pattern_assignment_ready.occurred_at 写成数据库 CURRENT_TIMESTAMP，而条件事件及 complete 读 BusinessClock。MAX 条件时刻因此污染 entered_at。现条件和对应事件使用同一个已验证 businessNow；条件汇总、真实接收、完成校验、未知事实和截止逻辑继续沿原服务。审计/认证/基础设施时间仍取真实时间。

场景/来源/文档的既有断点恢复与锁顺序保留，不把多次原生提交重构成新事务平台；权限拒绝不会创建空场景。其他基础设施失败仍可按原 request key 续建，已有文档不重抄，不覆盖后续编辑。

## 回归设计与实际证据

本地独立 Docker PG16、低权限隔离数据库及安全 marker、完整迁移 schema；没有连接 Acceptance 或生产数据库。

- 新增权限零残留反例在未修基线确认：UAT 文员 403 后 scenarios 由 0 增为 1，source/resource 均 0。
- 新增原生时间反例在未修基线确认：-2h 和 0h 参考墙钟场景在车板完成时报“发生时间不能晚于当前或早于任务进入”；+2h 完成能过但自动条件时间仍为真实墙钟，和场景时间不一致。不是仅用未来时间证明修复。
- `acceptance-sla-clock-postgres.test.ts`：21pass / 1浏览器skip。包含普通文员拒绝、设计师缺 capability 拒绝、创建开关拒绝且场景/资源/来源/冻结记录零增量；授权同 key 并发成功；来源提交前/后中断、运行时重建及单一冻结初始化；既有复制文档保存前/后中断恢复、不覆盖编辑。
- 三种墙钟偏移各跑原有四条工艺/洗水原生链。仅在创建全新隔离夹具时冻结测试 Date，然后恢复真实时间，执行接收/自动激活/完成时不 mock Date；业务起点、条件、完成均等于持久化场景时间，审计仍接近真实墙钟。普通无场景来源任务接收/激活/完成保留真实时间；原全 schema 原生链继续通过。
- `acceptance-sla-clock.test.ts`：6/6。API typecheck、改动文件 ESLint、diff 检查及工作树 secret scan 通过。
- 最初完整回归暴露测试夹具自身两处问题（新 boot proof 使旧 runtime 失效；前序测试已将标准改为20h而原生 helper断言24h），已沿原守卫重建 runtime、显式选首个既有标准，重跑整组通过。未改生产守卫或降低断言。
- GitHub Full Gate 另核最终 Head；浏览器skip不计通过，本地/CI不代表现场全链补验。

## 现场及历史处理边界

未修改或删除已有空场景。建议父线程在保留请求key、403及审计证据后，另行核验空场景确实没有业务绑定，再决定保留标注或独立授权的历史处理；本 PR 不提供自动清理或隐式重绑。

现场 C source `1c8f06d9-eb82-445e-a729-4d8e596fe6cd` 和同现 D 的历史原样保留；不推进时钟、不改 entered_at。新代码阻止新增污染，不能据此宣称已有污染历史已修好；后续现场恢复须父线程另行核实原操作证据和处理方案。

老板现场批准未重发；后续授权的同类时钟遗漏见下节，现场 POST 网络错误码未采到。裁床标准 UAT 种子缺 cutting_worker 是测试前置，独立 fixture 仅交方案，不新增现场账号或授角色。本任务不 ECS、不部署、不合并、不发 Codex Review。

## 追加：老板批准 PO 交期时的同类时钟接线遗漏

父线程新增授权后，先在未修 `9b0a899f` 的独立隔离工作树复现，再补入本 PR；未改 #860 或新增大 PR。

- 原链：`approveFactoryPoDates` → `DigitalPoDateRepository`（未显式传 clock）→ `recordSlaPoDateChange`（默认 SystemBusinessClock）。本单已有非 null 场景的 SLA plan，首次 null→工厂日期的批准会落回 `{scenarioId:null,revision:0}` 与墙钟，`SlaPlanRepository.appendPlan` 的原防回退守卫抛出 `SLA clock scope or time cannot regress`，老板批准整事务回滚。
- 未修基线的三组隔离对照全部完成：真实 Acceptance 控制登录/老板岗位，开发发布→母单→预算版本2冻结→IE5元×10→供应链选独立 TEST factory2。场景首次日期变更精确复现报错且 seq3/owner0/snapshot0/date0/plan1 不变；同场景日期已相同与普通无场景订单均批准成功。不是 response 契约推测，也未向现场重发批准。
- 父线程随后取得现场两项定向只读事实：planRevision1、场景业务时间 `2026-11-01T09:57:06.915Z`/clockRevision6；映射 PO 工厂日期版本0、当前null、提议2026-12-10，确需变更。与本地复现链一致；未采到现场 POST 网络错误码，不把本地日志当作现场服务器错误日志。
- 修复仅把共享 PO 日期 SLA 适配器缺省时钟改为 `ContextBusinessClock`；三处调用完整核对：首次 PO 登记（尚无 plan 时仍不造计划）、客户交期批准、工厂批准/合同交期变更共用适配器。已显式注入的 BusinessClock 保留，普通无场景仍为真实时间。scope/time 防回退、审核权限和旧 migration/checksum 均未改变。
- 新原生回归覆盖首次 null→2026-12-10、日期不变、普通单、同 key 重试只一条老板决定/批准快照/明细/成功回执；场景时间及 revision6 保留；原 SLA 冻结 snapshot 保留；再走客户交期原生申请/批准，测试通知不外送。
- 故障回归在工厂日期与新 SLA plan 均已写入事务后故意抛错，核 owner decision/snapshot/lines/date/plan/operation event/idempotency receipt 全部回滚，随后同 key 正常批准成功。未使用外层 ROLLBACK 包真实已提交服务。
- 追加后完整 clock PG：25pass/1条件浏览器skip；SLA plan PG4项及 clock单元6项共10pass；API typecheck、改动文件 ESLint、diff和secret scan通过。调查夹具的编码/角色单例/附件复用/审批精确字段/SQL类型与 reused标记问题已修正夹具，没有改生产守卫。
- `361cddae25907f4cc2687ab6ef5870cbc5ead189` 的 Full `40320833645` 原已成功；追加产生的新 Head 必须重新核最终 Full Gate，不复用旧绿灯。#860 Head `a2bc4cc41deadcf5ab1c6c0413eb588970b84f90` / Full `40320650533` 成功且保持不变。
