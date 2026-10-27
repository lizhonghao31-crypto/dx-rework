# PR2：生产填报日期的原单时钟契约

## 基线、范围与顺序

- repository: lizhonghao31-crypto/dx-rework
- base: release/digital-production-v1 @d89dcc2b0029ec65c530e7625c7a16f204f8afbc（PR1 #864 已合并）
- base tree: f6de69ee395b45b0b82600d7aa33729f2d47f985；main仍67841e105fe7090e219477171d3cf79565719241。
- branch: fix/acceptance-production-reporting-clock-pr2-20261027；worktree独立，新基线已实际核验。
- gate: FULL。仅本PR完成测试、最终Head Gate、一次必要Review及处理发现、release合并后，才开始PR3。
- allowed: production-reporting入口/hook/服务/契约/日期控件、原转厂执行起始业务日期、追加0264迁移及manifest/低权限依赖清单、定向原生/安全/兼容测试、时间责任清单。
- forbidden: main、部署/ECS/现场数据、历史migration/checksum、权限或原数量/范围/版本守卫放宽、合同回签PR3、历史/坏单隔离PR4、生产页迟到响应/导航等PR5、交付工具PR6。

## 已定位的原入口链

| 入口/消费者 | 当前来源与缺口 | 本PR契约 |
| --- | --- | --- |
| acceptance-clock/hooks → /production-reporting/:id | 前缀漏接；原生production ID可经已有clockRoots → 原母单 → 原scene解析。 | detail、report、correction、complete、ship沿原ID进入现有guard/唯一scene锁/ALS。全局列表和scopes不接受任意场景时间；混真实/测试或跨scene拒绝。 |
| ProductionReportingService.report/correct/execute | today/dateCheck直接读取墙钟；日终边界还可能与SQL事务时刻不一致。 | 输入仍是业务日期，保留原用户填写；同事务由DB原生链/当前事件/原scene给出北京时间日期上限，并在API返回明确日期校验错误；不通过改客户端header/JSON/GUC供时。 |
| guard_sourcing_production_report / execution（0236） | CURRENT_TIMESTAMP北京时间墙钟上限拒绝未来场景，不能只改API。 | 追加迁移替换对应函数，保留原授权、派单下界、scope、款色/数量、最新revision、完成及发货顺序所有条件，仅接入经DB验证的本单上限。 |
| sourcing_production_reports、append correction | business_date用户实际日期；created_at为真实审计。 | 校验后保存原日期，原记录/更正关联不可覆写；同key/不同key、失败整事务回滚不变，幂等过期继续真实时间。 |
| complete → transition；ship → transition+shipment | 共用dateCheck及SQL execution guard；business_date/shipped_on与created_at分开。 | 完成日期不得早于原派单/有效日报，发货不得早于完成；shipment与对应transition同日期/事件/工厂执行版本，物流/收货下界仍接同事实。 |
| 初次数字派单 | dispatchDigitalWithClient已经从原仓库实际发厂fact传occurred_at给production.dispatched_at和seq1.business_date。 | 保留这个真实业务事实来源，不改成当前scene now；旧独立非数字派单仍真实时间。 |
| 转厂后的执行seq1 | factory-transfer-service把transfer.effective_at墙钟转为business_date。该effective_at被0236强制等于statement_timestamp并用于历史数量分配cutoff。 | **effective_at和transition.created_at继续真实审计**，不全局替换；只将新执行的business_date改由同一已批准转厂事件/原单scope验证的业务日产生，兼容普通单原日历。原transfer授权、数量快照、历史cutoff不改。 |
| Detail → ProductionReportingDetailSchema → 日期控件 | 服务无可信本单businessToday/asOf；页面初始/default/max均浏览器墙钟。 | GET返回本单可信businessToday/asOf。日期控件default/max使用它；未获取可信元数据时禁用日期提交并提示刷新，不退回浏览器墙钟。 |
| 旧成功幂等回执 | 升级前已保存detail JSON不含新增日期元数据。 | 新元数据成对向后兼容；缺失表示日期上限待重新读取，不伪造历史时间，也不使已成功回执因新增字段变成“未知提交”。保留原请求key和恢复窗口。 |

## DB信任边界（实现前冻结）

1. 从sourcing_production_orders的原case及不可变digital child links核production→原母单；数字单缺链、production/case指向不同母单、legacy假挂接均拒绝，不按款号或客户端ID猜测。
2. 业务日期上限只从真实数据库scene.business_now取得；原单无scene保持数据库真实事务时刻的上海日期，普通未来日期仍拒绝。原单无scene却声称虚拟clock不得获得例外。
3. 场景例外要求实际Acceptance数据库/原UAT Root及corp前置、当前操作事件同事务、actor为本corp有效双UAT标识、metadata的原scene ID/clock revision/now与DB完全相符。原事件action/entity/actor/厂版本/数量等守卫原样保留。任意session GUC、客户端JSON、无事件或旧事件重用均不能授权未来日期。
4. 原绑定不可重绑；SQL守卫独立于HTTP是否正确接ALS。detail在没有已验证reader时不得将已绑定scene静默降为墙钟。已有事务内读取复用其连接，避免重现PR1审查的同池饥饿。
5. 新业务日期与真实created_at、recorded_at、transfer.effective_at、会话/控制码/网络/幂等TTL明确分开。旧错误TEST/旧transfer日期与历史事件不更新；不从当前now反推过去实绩。

## 冻结回归矩阵

- 全新隔离native链：来源/母单、预算/选TEST工厂/批准、纸样/验布/原实裁、仓库发厂→原production→日报→追加修正→完成→shipment→原物流/收货事实。原角色及全部DB trigger启用。
- 过去/当前/未来scene及普通真实订单；过去不借未来clock遮蔽；多个scene并发，混scene/真实拒绝。北京时间15:59:59.999Z与16:00:00.000Z、上限当日允许/下一日拒绝。
- detail/max/default在浏览器墙钟与scene明显不同时仍按本单；旧回执缺元数据只等待可信GET；不同订单/工厂执行日期来源不串用。原页面迟到响应/返回列表缺陷仍明确留PR5，不冒称已修。
- API接线与DB直接负例分别验证：metadata缺失/错误scene/revision/now、无当前事务事件、实际非Acceptance数据库/非UAT、伪GUC/JSON、缺或错原链，普通单未来日期不放宽。
- 初始派单/转厂执行版本、厂范围允许/拒绝、Root原特权、数量上限、最新revision、完成前发货拒绝、完成后日报拒绝、修正晚于完成拒绝；原审计时刻不随clock。
- 同key重试/并发、不同key重复与冲突、报告/修正/完成/发货中途失败整事务回滚，原回执及数据不留半链。
- PG13.23/PG16；追加迁移历史兼容、全类型/构建及现行必需门禁。未执行的矩阵逐项保留未测，不把本地通过当现场复验。

## 实现及逐入口时间分类

| 已核入口/消费者 | 分类、实际 clock 与归属 | 证据及边界 |
| --- | --- | --- |
| hooks：detail/report/correction/complete/ship | scope 安全解析，沿原 production ID → immutable production/sourcing links → 原母单 scene；不从 header 获取 now。 | 原生 HTTP：无 scene header 仍正确接入；错误 scene、全局列表套场景、无登录均拒绝。旧所有前缀保留。 |
| ProductionReportingService.report/insertReport/correct | business_date 是用户实际上海日期；当前同事务 operation event → SQL 上限；派单 lower bound、数量、角色、scope、最新 revision 原样。 | 过去/当前/未来/普通单；未来一天/早于派单/越量/非Root修正/旧版本均拒绝；原记录保留。 |
| execute complete/ship → transitions/shipment | business_date/shipped_on 属业务日期；共用同 event/date；原完成与有效日报下界、先完成后发货不变。 | 4类时间域全部完成至 shipment；跨业务日早完成/早发货/修正晚于完成均拒绝。 |
| 0264 clock_scope | scope 安全事实，校验 workflow_generation、原 case 与原 production 两个不可变 child links 同母单，不能重绑或借另一scene。 | 原生四类时间域；跨scene/混普通读取拒绝；原绑定不可变守卫由原 clock 回归保留。 |
| 0264 business_date 与两原日期上限 trigger | scene.business_now 是业务时刻，DB 的原场景/当前 clock version 为权威；普通报数/完成/发货保留 CURRENT_TIMESTAMP 上海日。 | 无metadata、错误scene/version/now、旧事务事件、伪GUC和失效UAT均拒绝；原SQL守卫仅替换日期来源的契约测试。实际数据库名及Root/corp证明明确在SQL；未连接真实生产库做负例。 |
| 初次数字派单 | 原仓库实际发厂 fact.occurred_at → dispatched_at/seq1 date 为业务事实，保持。 | 全新 native actual cutting→warehouse dispatch→production；不以当前 now 替代已给定实际发厂事实。 |
| 转厂 approve → new execution seq1 | 场景使用当前同事务批准事件/原母单业务日；普通单保持原 transfer.effective_at 上海日，包含跨事务午夜语义。 | 过去/未来/普通三类转厂；余量8保留原厂已做2；新执行日报/完成/shipment；effective_at=seq1.created_at 且仍真实墙钟。实际午夜跨事务等待未人为修改数据库墙钟，普通原始 fact 日期选择由源契约测试锁定。 |
| transfer.effective_at、seq1.created_at | 真实审计/历史数量截点，未改默认或写入，statement_timestamp 原trigger保持。 | 业务日期来源之外的0236三个函数逐字保留；未改旧 migration/checksum。 |
| detail → GET businessToday/asOf | 业务“当前日期上限”的观测值；ContextBusinessClock 按原母单、经过 boot guard 的 reader；无scene使用数据库真实事务时刻。不是整份历史一致性快照或旧实绩时间。 | 无ALS可信reader可读取本单；未安装reader对已绑定scene拒绝降级；已有事务复用其连接。 |
| 页面 default/max、report/complete/ship/correction 控件 | detail 元数据只供匹配的原生产单/工厂执行；默认及上限均来自 businessToday；无元数据不回退浏览器时钟。 | 实际 Chromium 的墙钟固定2001年，过去/当前/未来、本单刷新保留选择、Root修正、缺元数据、旧成功receipt共6项。身份/订单切换迟到响应总修复仍PR5。 |
| 成功幂等回执、恢复窗口 | 成功 response 原样；新元数据成对 optional 只兼容历史receipt；过期/网络/恢复窗口及身份会话均真实 Date.now。 | 实际事务写入旧编码receipt后原key经新服务/HTTP重放，业务不重复，缺元数据不被伪装成当前历史；新GET再取可信上限。原恢复浏览器26项通过。 |
| receiving → receipt links → factoryReturnLogistics | receiving.received_at 已用原 businessNow；receivedDate 的日期精度及 shipment.shipped_on 保持，不制造实际午夜瞬间。 | 四类时间域原收货服务/原试点关联/原物流读完成；原物流dispatchPrecision=date、actualDispatchedAt=null。未修改收货实现。 |
| report/transition created_at、operation_events.created_at、attachments及身份/幂等TTL | 真实审计/安全时间；asIso仅序列化已有时间，不是业务 now。 | 新原生回归断言真实审计仍接近真实时刻；SLA/日期例外没有修改这些默认或旧实绩。 |
| production dashboard/closure 风险扫描与历史/列表 | 读取时间全链另属PR4；本PR仅让其原 detail 委托带回可信日期上限；不将审计列重新解释为业务实绩。 | 普通旧报数/看板/转厂/收货原回归复验。场景风险、坏样本隔离与历史同秒证据仍待PR4；不宣称本PR已覆盖这些后续责任。 |

## 本地验证记录与限制

- RED：原生未来scene的原 report 在API以“业务日期不能晚于今天”失败；带合法当前事务event的直接SQL INSERT独立失败“invalid production report authorization or date/state”。全trigger启用。
- PG13.23：新增日期链19项及既有 clock/anchors聚合63通过、1原有可选live-browser跳过；随后补充的真实旧receipt测试1通过，另外19是该次定向过滤、不能当作又通过一轮。新测试总计20个已执行。历史升级12条lane通过。
- PG16.15：最终新增20项及既有clock/anchors聚合64通过、1原有可选live-browser跳过。PG13另做旧生产/转厂/分厂可见/风险责任4项通过、136是该次过滤；不声称在PG13跑完旧外发140项。
- Chromium：新增6项日期控件、既有26项提交/未知结果恢复通过。都只访问本机合成TEST HTTP，不是现场Acceptance复验。
- 全量单元482文件2524项、全workspace类型、API/web构建、lint、migration lint、main/release兼容源检查、secret scan通过。前端保留原bundle体积提示，未调整阈值。
- 初版旧外发140项中139通过、1失败：新增asOf的实时观测让原“失败操作不改业务资料”的两次detail全对象比较不再相等。现在仍完整比较所有业务字段及businessToday，另验asOf非递减；精确幂等回执比较不归一化。最终PG16完整140/140通过；PG16最终聚合亦通过。
- 夹具初试改变稳定union键被原不可变identity trigger拒绝，未执行；未关守卫。最终失效UAT负例用可变active=false并ROLLBACK。Root/corp SQL证明有源契约测试，未伪称可改不可变Root键来构造线上状态。
- 每个report/correct/complete/ship注入真实本地AFTER INSERT失败，比较operation_events/idempotency_records/report/transition/shipment五表行数不变，原key重试及成功重放通过；不是整库全字段快照。没有现场历史处理或线上写入。
- 全时间候选索引目前403文件1583个来源；仍是待逐条语义核定的候选，不表示这些候选已全面通过。当前PR的分类及回归在上表；PR3–PR6保持未施工/未验证。

本PR本地验证、最终Head CI、唯一Review、release合并、部署、业务验收是分开的状态。六PR全部完成后仍须冻结最终组合树并重跑全部新增/受影响矩阵；之后仅由用户执行一次Acceptance更新与业务补验。
