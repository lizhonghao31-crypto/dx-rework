# PR4：工厂回仓物流日期范围读取

## 开工与契约

- repository: `lizhonghao31-crypto/dx-rework`
- base: `release/digital-production-v1` @ `997bbef6ea861c68a50b89ebbfb1f492bc970c48`（#876同步合并后）
- branch: `fix/acceptance-logistics-range-pr4-integrated-20261030`
- gate: FULL；当前仅本地施工、待独立推前检查，不 push。
- 规则已读：AGENTS V2.1、construction workflow、数字 SLA Golden Source、外发/生产 Golden Source、Acceptance clock 契约。仓库无 `.agents/skills`；执行器的现有本地测试条件复用，无新软件安装。
- 允许：原物流读取、SLA/Journey 只读 DTO 与座舱展示、相应测试和时间候选索引。
- 禁止：main 热修、迁移/历史事实改写、审批/权限/金额数量规则、PM2、ECS、部署或新增物流录入/节点。

原生 `shipped_on` 是北京时间业务日期。现有 `factoryReturnLogistics` 已按本单冻结标准和显式应用记录，生成 `[本日期00:00＋标准时长, 次日期00:00＋标准时长)`，保留 `dispatchPrecision=date`、`actualDispatchedAt=null`。数字 SLA 为连续自然时间，物流不套用合同回签的周日暂停。默认2880分钟：12/6发货对应12/8全天，不是12/8某个实际到仓时刻，也不是收货硬截止。

## 全部同范围入口/消费者

| 链路 | 处理与边界 |
| --- | --- |
| 日报完成/登记发货 → 原 shipment | 原命令、SQL guards、日期、数量/版本、操作审计均不修改 |
| `factoryReturnLogistics` → FactoryFlow/收齐预测 | 原有可信范围和冻结版本算法不改；使用原 `estimateExpired`、到仓事实和证据 |
| `factoryProductionFacts` 的 native allocation → PO | 复用原 productionId + factoryDecisionId + lineId 映射；不按款号/日期猜归属 |
| `SlaOrderService.read/readWithClient` | 同一授权只读快照、同一已验证 BusinessTime；仅现有 `read_projection` 展示模式为对应 estimate 节点附原范围；正式应用默认严格模式不附展示字段 |
| `DigitalJourneyQuery.list/read/export` → `readJourneySupervision` | 共用原适配；透传同一 `logisticsWindows`，不引入列表墙钟或跨单共享时钟 |
| Acceptance clock 控制页目标读取 | 原 `SlaOrderService.read` 后只提取精确 `deadline.at`；物流仍null，不新增时钟推进目标 |
| `evaluateSlaPlan` / 计划、进度、风险、后继依赖 | 算法不改；精确 start/forecast/deadline 仍保持原精度，不把范围端点喂入 max 或后继开工依据 |
| 座舱原“当前有效时效与计划历史” | 显示厂名/发货日期及完整含/不含端点、北京时间、过期预计说明；无假精确时间/按时评级 |
| 正式应用标准、已到仓历史窗口 | 沿原 completedWindows 排除与冻结快照；不改 P0/Pk、原实际完成/评级，不重算历史 |

不新增 Journey 业务节点、待办、负责人或读权限。`logisticsWindows` 只是原生范围 DTO；即使日期证明已登记发货，也不制造精确 `actualStart`、`actualEnd` 或业务完成事实。页面使用“已登记发货日期”，不把日期精度误显示为精确计时已启动。缺发货、缺原生归属仍保持 unknown；其它可分类/不可分类异常沿原规则处理。

## 验证矩阵与失败记录

- 红测：原业务实现不变时，PG16真实新单完成报数/生产完成/登记发货，工厂页已有12/8范围，而整单/座舱缺范围，1/1明确失败。
- 首轮绿测：同一目标1/1、相关单测17/17通过。
- 扩展矩阵首轮8失败/1通过：测试误用裁床 `position`，真实字段为 `sourcing_line_position`；1个后继因前置未生成连带失败。仅修夹具排序。
- 复验8通过/1失败：无权读取按既有 `DigitalProductionAccessPolicy.assert` 返回404隐藏资源，测试误写403。已按 `access-policy.ts` 原规则修正并让该用例独立建单，不改授权或业务实现。
- 双PG再验各8通过/1失败：普通 worker 无数字生产身份，Journey列表入口按 `assertIdentityActor` 返回403，测试误期望空列表；改为严格断言403，仍断言单单资源隐藏404。仅复验该1项，保留其余8项已有结果。
- 最终矩阵：past/current/future/ordinary、北京跨日、Sunday48自然小时、范围排他边界±1ms、多场景/普通单隔离、原厂/转厂与两PO、已到仓应用标准和后续时钟、无权/无发货依据、原生事实快照不变。
- 最终执行结果和完整 diff 在独立交付文件中记录；未结束的运行不记为通过。组件输入必须来自最终隔离 PG DTO，不以 mock 替代原生链。

最终本地结果：PG13.23、PG16.15各29个不同目标用例通过（本PR9项为先8通过、再仅复验权限/缺依据1项；另原生产日期完整20项，各批记录独立保留，不冒称单轮29项全绿）。原生两PO转厂的两个工厂scope与发货日期不串，默认单PO夹具输出保持原样。全单元488文件2591项、实际产品组件36场景（18个PG DTO、桌面1440/移动触摸390）、typecheck、完整lint、改后目标lint、workspace build、时间候选索引、secret scan和diff检查通过。PG真实版本及低权限角色已单独读取；完整278迁移/原SQL守卫保留，随机自有schema均已清理。

只读快照断言覆盖所列5张表的全部现有行/列：`sourcing_production_reports`、`sourcing_production_transitions`、`sourcing_production_shipments`、`receiving_receipts`、`sourcing_production_receipt_links`。正式应用标准允许原SLA append-only记录变化；原发货/实收和审计快照仍不变。不能把该范围称为整库不变。组件HTTP为本地只读传输，移动为Chromium模拟，不声称现场登录、实体手机或实际OSS下载已验。

## 推前独审 P2：展示字段与正式应用边界

独审指出最初无条件附加 `logisticsWindows` 会进入 `SlaOrderApplicationService.prepared` 的 before；after 来自裸 `evaluateSlaPlan`，两者完整比较产生无关物流变化。真实原生单确认两条红测：只选已完成IE时预览错误放行；合法未完成质检调整时也误包含未改的物流项。首个探索夹具没有装配待办投影，IE完成事实缺失，不能算该场景已复现；补齐原 `SourcingService` + `TodoProjectionService` + `TodoService` 接线后重新红测2项均命中，没有手工插入完成事实。

最小修复仅在原 `read_projection` 模式附加范围；正式应用使用默认严格模式，前后仍按原业务评价比较。没有删除差异、过滤真实变化或放宽全已完成拒绝条件。普通整单GET和Journey列表/详情原本已明确使用展示模式，完整调用者已核对。

增量验证：PG13.23/16.15各新增2项目标回归通过，严格reader没有展示字段；全已完成的preview/apply均按原原因409拒绝，所列7张表全部现有行/列快照不变：`digital_sla_order_snapshots`、`digital_sla_plans`、`digital_sla_node_facts`、`digital_production_task_events`、`digital_production_commands`、`digital_production_tasks`、`digital_production_deadline_revisions`。apply无预览可发放时使用明确的TEST无token输入，并断言在token校验之前已因“无未完成节点”拒绝；合法未完成用例取得真实预览token后实际apply，版本只加1、无关物流不入changes，保留全部原IE事实字段和物流范围。原生前后报数/发货/实收5表快照同样不变。

增量相关17项单测、API类型/构建、目标lint、时间清单、secret和diff检查通过。此前2591项完整单测、36项组件和29项/PG结果保留复用，没有冒称它们在修后又整套重跑；增量后每PG共31个不同目标用例已有通过证据。UI及精确时间计算代码在本P2修复中未改。

修后另仅复验已到仓窗口经正式应用标准仍保留原范围的原生用例，PG13/16各1项通过；这是已有用例复验，不再增加“不同用例”计数。

## 独立门禁阻断与解除

开工时真实 main 已为 `dc880453323de96599f57afafcc8f7c6f11c6756`，含另一 Work 的 `0231_temporary_special_process_proxy_reporting`。本 PR 保持 release278条迁移不变。正式 `check-main-release-compat --worktree --expected-main-sha dc880453323de96599f57afafcc8f7c6f11c6756` 已实际失败：`MISSING_MAIN_IDENTITY`、`MAIN_LANE_IDENTITY_SET_MISMATCH`、`Applied migration is absent from Head manifest`。不把此失败计通过，不夹带热修或放宽 policy；需父协调独立的 release 迁移兼容处理后才能请求最终 Gate。

以上为原4ab810d8基线的历史阻断。#876已独立同步并合入release997bbef6，完整279条迁移成为新基线。本物流补丁原样迁入新独立worktree，14个已审文件迁入时逐字节一致、无冲突；仅本文更新基线与验证记录。物流diff不复制#876文件、不改变SQL/manifest或权限。新基线的源码兼容和受影响物流/P2/组件回归结果在交付文件记录；原完整单元证据保留，不冒称新基线已重跑旧全量。

迁后实际复验：源码兼容WORKTREE_NOT_DELIVERY通过，main231/candidate279/tool279、issues=[]。PG13.23/16.15完整物流套件各11/11通过，包含四时间域、范围边界、两PO/转厂隔离、已到仓历史、权限/缺依据，以及P2的preview/apply全完成拒绝和合法未完成调整；全部使用新基线279迁移。相关单测3文件41/41通过；新PG16生成18份真实DTO，原座舱/工厂产品组件在1440桌面和390触摸模拟下36/36通过，无页面错误或外部请求。工作区类型、API/Web构建、改动文件lint、时间索引、secret和diff检查通过。没有重跑此前2591项完整单元或20项/PG生产日期套件，保留其原时点证据。

补充只读测试条件探针首次因遗漏NODE_ENV=test被原安全检查拒绝，发生在数据库连接之前；按既有测试入口配置修正后，通过同一守卫读取实际13.23/16.15、角色dx_price_pr1_test且四项高权限均false、自有business_anchors测试schema余量0。未修改安全守卫或角色。组件仅本地Chromium模拟，未核现场或实体手机。迁后代码无新增业务修复，13个非工程文档文件与已审版本逐字节相同，只有本文基线/结果说明变化。

现场旧样本、正式数据库及当前 Acceptance 未读取或改写。本地与 CI 不能证明旧样本已修复或现场验收通过。
