# main临时特殊工序热修的独立release同步

- repository: `lizhonghao31-crypto/dx-rework`
- base: `release/digital-production-v1` @ `4ab810d8b565a059c2cf69bbd7b649c2a651f1e4`
- original main: `dc880453323de96599f57afafcc8f7c6f11c6756`（#875）
- branch: `fix/release-main-proxy-sync-20261030`
- gate: FULL；先完成本地验证、独立推前审查，未授权前不push。

仅同步原始 `0231_temporary_special_process_proxy_reporting.sql`，SHA256固定 `39a9c918c6589c9905ab0cf32de1f7cc304119fd4840a3fa8da34ddfb3e3d6b4`。保留原 `0231_digital_order_closure` 完整身份和checksum；使用已有精确配对策略，不改迁移策略、旧SQL/checksum或现场历史。manifest为279条，末版本仍为 `0265_contract_return_business_time`，成功必须核完整身份/数量，不能仅核末版本。

允许范围：原SQL、manifest、main extension lane、Acceptance精确准入inventory、既有测试/验证入口、main热修原生回归的release适配、本文。实际11文件：完整单测发现固定248条旧Acceptance样本误纳新增0231，须额外维护 `main-sync-release-history.test.ts`；保留248条原断言，并明确新热修只在当前manifest，不将历史样本改为249。推前审查另要求在既有 `migration-compatibility-postgres.test.ts` 补齐空库完整重放后的proxy函数及trigger终态断言。不整main merge，不引入生产main维护工具，不混PR4物流补丁，不操作main、ECS、生产/Acceptance数据库或部署。

## 入口与完整迁移终态

原SQL创建 `rework_work_report_actor_authorized(uuid,text,uuid)`，替换 `guard_rework_work_report_insert()`。保留当前模块、身份、角色/有效委派、临时成员快照、任务/订单状态、事件/actor/request/entity绑定；Root及正式工本人能力保留，不改变数量、工资、版本、幂等或重报规则。新分配仍查有效人员；停用临时档案不破坏旧分配快照。

原生回归先以main230真实schema复现混批失败，按原SQL升级为main231并验证成功/同key，再用正式 `applyMigrations` 升至完整release。其余#875原断言全部在完整279迁移之后执行。两函数完整 `prosrc`、security/volatility和实际insert trigger绑定均核对原SQL，不以函数名或字符串片段代替终态证明。

既有 `main-release-history-drill.mjs` 使用真实main231与release278两个Git历史、固定原SQL和官方Acceptance维护生成器，在隔离Docker中核低权限preflight/apply/repeat。保留原history/checksum/applied_at、已有relation ACL与原guard/helper owner/ACL，并核应用角色执行边界。新增0231缺inventory/错误checksum/guard owner不匹配拒绝。此测试不会访问用户数据库URL。

空库完整重放使用既有 `migration-compatibility-postgres.test.ts` 的empty目标；不把仅适用已初始化Acceptance的维护入口当bootstrap。main230→hotfix→integration、main231→integration、release278→integration、空库四路径分别验证，PG13.23及16执行。

## 计划命令与完成标准

- `check-main-release-compat.mjs --worktree --baseline-ref 4ab810d8... --expected-main-sha dc880453...`：本地只读源码兼容，明确WORKTREE_NOT_DELIVERY；最终Head另核。
- `temporary-special-proxy-postgres.test.ts`：原生允许/拒绝、临时停用、有效/撤销委派、混批回滚、数量/版本、退回重报和工资源幂等。
- `main-release-history-drill.mjs 13|16 <proof>`：官方低权限双历史、精确guard、ACL/历史和失败准入。
- `migration-compatibility-postgres.test.ts -t 'upgrades empty'`：实际空库全迁移及幂等。
- migration/branch/source兼容单元回归、完整单元、lint、迁移静态lint、drill语法、secret、时间索引与diff检查。

实际结果、失败日志与完整diff在交审文件记录，未结束不计通过。无代码差异的旧范围证据合理复用；最终CI/Review、合并、部署和现场业务验收分别报告。本地验证不能冒称最终精确Head Gate通过。

## 实际本地结果

- PG13.23 /16.15原生回归各16/16：先main230旧失败、原样热修成功/重试，再完整迁移至279后执行其余原授权、停用临时成员旧任务、新分配拒绝、正式工本人/Root、撤销委派、模块只读、审计绑定、数量版本、混批数据库拒绝回滚、退回重报、工资源幂等断言。
- 官方低权限维护双历史：真实 `dc880453` main231→279、真实 `4ab810d8` release278→279，在两个PG版本均通过preflight/apply/repeat；旧身份/checksum/精确applied_at、原表/分区/序列ACL，以及已存在的报数guard/helper owner/ACL保留；实际trigger和两个完整prosrc/security/volatility匹配原SQL。release路径实际验证guard owner错误、缺inventory和错误checksum均拒绝；权限异常只在隔离fixture恢复，不修改用户权限。
- 空库完整重放：既有empty目标在两个PG各1项通过，其余11项被过滤，未计通过。首轮只直接核sourcing guard，不能据此声称已核proxy终态；推前审查后补两个proxy函数完整prosrc、非SECURITY DEFINER、原volatility及实际insert trigger精确绑定/启用断言，在完整279迁移之后执行。仅定向复验empty：PG13.23为1通过/11过滤（7.26秒），PG16.15为1通过/11过滤（6.78秒）；后续迁移未覆盖原热修函数，原幂等、历史/漂移与清理断言保留。其它已通过数据库/单元套件未重复；新增测试文件目标lint和diff检查通过。
- 迁移/分支/源码兼容定向单测29/29；完整单测首轮2590通过/1失败，失败是固定248历史样本误包含新0231，保留248原断言并排除这个未来身份后，该原套件2/2复验通过。未重复2590已通过项，不冒称一轮完整零失败。
- 新原生套件在无DB配置下正确收集为16 skipped，不把skip算业务通过。完整lint、后改历史样本目标lint、迁移静态检查、drill语法、时间清单、secret和diff检查通过。
- 最终本地源码兼容为 `WORKTREE_NOT_DELIVERY`、main231/candidate279/baseline278、issues=[]。正式inventory只增加0231一项，保留原JSON键顺序以去除无关diff；与前次已测inventory的JSON数据完全相等，仅表示顺序恢复，因此未重复数据库测试。

原生迁移前后业务断言范围为原单status/version、报数完整行、份额完整行和对应报数event身份；维护脚本另保留TEST用户id/name/enabled。不能将这些证据泛称整库所有历史事实已现场核验。工作树未提交、未push、未建PR，GitHubReview/Full/Final、现场升级与业务复验均未执行。PR4分支及已审物流补丁保持不变。
