# main → Acceptance：合同待办、回签周期与价格重新申请同步

## 授权与源码基线

本次只在实际 Chat 窗口进行代码同步、必要测试、提交和创建一个同步 PR。目标 base 为 `release/digital-production-v1`；不将 release 整体合回 main。合并、部署、重启、真实业务库写入、生产或 Acceptance 历史补录均不在本次授权内。没有恢复旧 OOM 任务或重新打开 Work。

| 身份 | 冻结 SHA | 说明 |
|---|---|---|
| 最终 source/main | `ecaf69992c03b826837a61cf2053d0ee6d1fe4c9` | 包含三项功能和 #849 最终修复 |
| #847 → main | `c8cafb0e9adb465bd652ac980f46f7374c3c12f8` | PR01 合并提交 |
| #848 → PR01 分支 | `affefecf9dc02dcc8c4a2fbfa6eeef42a66ffb55` | 不是直接合入 main；其内容已包含在最终 main 中 |
| #849 累计 feature Head | `14a09e06699b9104fb50f5947698a1eecd7baa89` | main 的合并父提交；包含 #848 |
| 同步 base/release | `4c731753b51e5f3b163e563457eb8f425bf9e603` | 260 项 migration，末项 `0250_todo_content_reads` |

以上是 Git 源码事实，不代表任一实例已部署或数据库当前库存。同步提交的最终 Head 由 Git 在提交时生成，记录于 PR；云端 Gate 必须绑定该 Head，不能用原 #849 的成功替代。

## 范围及 release 适配

1. **转厂待办可靠性。** 同步合同 ready 事务、savepoint/deferred、显式恢复、版本去重及双跟单资格。保留数字生产的主跟单交接锁和当前身份解析；交接后使用任务实际接收人与合同版本判断重复，不因旧 dedupe key 中的原人员 UUID 再生成任务。相应交接 guard 只增补转厂/调价合同类别与其版本键，保留原身份、审计和不可变字段校验。
2. **稳定业务回签周期。** 新的明确需重签业务快照登记独立周期；首次 ready 起算，北京时间、周日暂停。新 PDF、生成重试或同一业务合同重出不重置起点。签回绑定所选合同，保留旧合同、附件和签回证据。历史普通读取及 ready 重放不自动纳入新周期。
3. **生产管理同厂重新申请。** 只收单价、原因和不可修改的决定/合同基准。统一单价超过当前决定的兼容单价才走现有老板审批；不改为逐款比较。保留 #849 的单一未处理申请、精确幂等、并发批准、撤销/驳回/退回和合法改期后的快照继承。工厂、数量、工艺、加工厂交期和发裁片日期不变；不新增已派单/开裁禁令，也不扩张角色入口。
4. **既有 Acceptance 业务。** 合并保留 PO 日期与身份、数字生产任务/导航/通知、工厂余量与分厂结算、合同供应商补充信息。纯调价不制造转厂执行记录。后续真实转厂沿价格决定链回溯到实际执行决定，且在已经派单使用的调价决定处停止；真实执行余量与历史财务价格身份分别保留。
5. **最小工具边界。** 保留现有生产专用三单工具的显式 preview/apply 与 main 0229 准入，不把它变成 Acceptance 自动补录工具。不导入 main 生产更新包装脚本或 main 维护计划注册，不修改 CI 工作流、依赖版本或全局 UI 样式。
6. **安全扫描兼容。** 保留 #849 的候选 diff 精确复核，并保留 release 对删除内容和合并提交的扫描能力；hunk 内以 `---` / `+++` 开头的实际内容仍需检查，不增加路径豁免。

## 不可变 migration 身份与映射

同号不同完整版本通过既有 main extension lane 登记；既有 260 项 SQL 内容、完整版本名及校验和不改动，不重编号、不删收据。新增两个 main 身份与最终 main 文件逐字一致，尾部只增加一次 0251 桥接。

| 完整版本名 | 来源与处理 | SHA-256 |
|---|---|---|
| `0228_digital_bulk_preparation` | release 原身份原样保留 | `c50f93ea731b5e9e2b8cab781ad870bb53a1bef8271b913720d63d6efb5e7bb6` |
| `0229_digital_bulk_cutting` | release 原身份原样保留 | `be60e800d1c513da9ae9e25463eba2a92d9ca69b86489f847269743d0e1672bb` |
| `0228_sourcing_contract_return_cycles` | main 原身份原样加入 | `86eec9b3696bade0d7eda97773f9f5a4636f6b38e891879e6882437c7f16cb4c` |
| `0229_sourcing_price_reapplications` | main 最终原身份原样加入 | `633964acebe30386ae7d3877268dcb7519944e387ffeb9707fa4d92e3b3cc857` |
| `0251_contract_price_acceptance_bridge` | 本次增量桥接 | `fcaddd8b378656f7ff65e994c809c6e981d093f0a27d108ed0e9877a2806ff11` |

集成 manifest 共 **263 项**。`migration-main-extensions.json`、历史策略和 Acceptance 权限 inventory 同步登记，0251 必须具备上述两个 main 前置身份。原 release 260 项历史在未执行 0251 时仍为合法前缀。main 的旧 guard 经过桥接合并 Acceptance 的 0236/0241/0240 规则；原 PO 生效日期函数不覆盖。新增 bridge 没有历史订单/签回/待办/时钟 DML。

`0251` 涉及的既有函数所有权范围只有 `digital_merchandiser_todo_transfer`、`guard_sourcing_decision_insert`、`guard_sourcing_factory_execution`、`guard_sourcing_transition_insert`、`sourcing_factory_remaining_lines`；新增 `sourcing_factory_execution_basis` 由迁移身份创建。迁移必须沿既有静止维护流程一次完成所有待执行项和桥接，schema/代码未一致前不恢复服务；这只是后续部署边界，本次没有执行维护。

## 历史范围保护

| Case ID | 用户确认的当前款号标签 |
|---|---|
| `46983c93-bb0c-4a28-b23c-4531feb4ad41` | IN20562448 |
| `cb942dbe-d6b2-43b2-9f48-3933566b7cf0` | PD20560718；双跟单 |
| `edfb86e9-9206-419d-8faf-ca11cb7c88ac` | RO20547996 / RO20547997；同一 case |

标签用于识别；权限边界是精确 UUID，不能按款号或计数扩大。其余 27 单不写入、不误标未签、不通知、不要求重签。普通读取、应用启动、部署迁移和后台轮询均不得触发历史补录。

三单将来由用户独立执行：先显式只读预检当前合同/有效签回/资格/重复任务，后以同一证据和批次执行；换版或资格变化阻断并重新预检，已签/已存在任务跳过，重复请求幂等。接收人候选数不等于应新增任务数。历史周期起点取原业务合同就绪证据，不使用补录日。输出保持脱敏和可追溯，不输出合同正文、签名链接或人员隐私。本次没有执行真实预检或 apply。

## 验证与证据边界

- 本地工作区 Node 24.19.0 / npm 11.9.0；仓库要求的 Node 22.22.2 / npm 10.9.9 由现有云端 Full Gate 验证。本地 Node22 二进制不能执行 JS，因此不能把本地结果表述为规定运行时通过。
- 本地 package 构建、API TypeScript 编译、web 生产构建及应用类型检查通过。迁移静态检查为 263 项。
- 本地隔离 PostgreSQL16 的 `main-229 → 263`、`acceptance-260 → 263` 回放通过：原 version/checksum/applied_at 和合成业务哨兵保留；重跑零新增；漂移及未知历史拒绝。测试库仅回环地址、合成数据，不是生产或 Acceptance 实例。
- 增补回归覆盖：派单前调价成为真实执行基准；派单后连续调价及转厂后再调价的真实余量；两类版本合同待办随母单主跟单交接后不重复；双跟单实际创建；PO 混合日期不变；迁移前置缺失拒绝；三单 allowlist/27 单保护和既有 #849 功能场景。
- 二进制字体无法通过本地 GitHub 文本连接读取，仍以 release 原始 Git blob 保留；本地相关 PDF 测试受限，不能据此宣称完整业务 Gate 通过。PR 从原 release 树增量构建，未删除字体或证据图片。正常 GitHub checkout 的 Full Gate 负责规定运行时、字体、全业务链、PG13/16 维护演练和精确 source/main 兼容证明。
- 本地单元测试、最终云端 Full Gate 和必要独立 Review 的具体结果分别记录于 PR，未完成的项不能用原三 PR 的历史记录替代。

## 回滚、审查与交付

PR 标题使用 `[FULL]`，只有 Full Gate；保持同一最终 Head 收敛验证。高风险独立 Review 按仓库规则至多一次，在最终 Gate 通过后执行，不能用本地交叉审查替代。

在尚未产生新业务事实前可撤销代码候选；一旦新周期或 price_reapplication 已生效，旧代码会误读签回或不认识决定来源，不可直接退回旧语义版本。使用理解新周期和价格来源的兼容修复版本，保留所有迁移收据、业务事实、签回、任务与审计。禁止删迁移、修改校验和、重置计时或撤销真实签回来回退。

交付一份面向 release 的同步 PR，并记录 source/main/base/head、迁移映射和逐层验证状态。PR 创建、Gate 通过、合并、部署和业务验收分别报告。本次不合并、不部署，不提供或执行生产补录指令。
