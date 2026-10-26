# Acceptance 首轮场景创建与业务时钟修复

基线：`release/digital-production-v1` @ `9b0a899f748870807fe7c4277568ea30f581dd7f`。
分支：`fix/acceptance-clock-atomic-init-20261026`；Gate：FULL。
只处理已证实的场景权限残留和车板自动激活墙钟混用，补正误拦截另 PR；不施工 P09/P10。

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

老板单次审批响应尚未确认，不重发、不猜因混修。裁床标准 UAT 种子缺 cutting_worker 是测试前置，不新增账号或授角色。本任务不 ECS、不部署、不合并、不发 Codex Review。
