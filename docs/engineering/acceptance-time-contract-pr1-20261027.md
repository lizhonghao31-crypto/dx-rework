# Acceptance 时间契约与 PR1 施工边界

## 一次预检

- repository: lizhonghao31-crypto/dx-rework
- base: release/digital-production-v1 @21aa4de4f4c33c645d42aa60dcdc24cab0823480
- base tree: d95b9640c646a5f21a4512e913aa01726e03010c
- remote main: 67841e105fe7090e219477171d3cf79565719241；不施工或合入 main。
- branch: fix/acceptance-business-anchors-pr1-20261027
- gate: FULL；涉及业务状态、合同事实、追加 schema 和审计，遵守现行 risk-map，不修改检查内容或阈值。
- 规则：已读 AGENTS、施工流程、digital-sla-golden-source-20261023、acceptance-sla-clock-20261026。当前源码未发现额外 .agents/skills。
- 本轮严格串行六 PR：每个 PR 本地准备、必要 Review、最终 Head CI、release 合并后，才从新 release 创建下一 PR。本文只随 PR1 交付，不另开整理 PR。后续 PR 未创建或施工。

## 报告与证据范围

Library 第一轮报告 libfile_c9b5c43077c48191a213a4c2bf51bdda（115914 bytes）及独立探索报告 libfile_a6e2ac8aceb081918cd701744e9d5dfd（68645 bytes）已物化并验证 UTF-8、字节数及 Library 身份。它们是现场观察记录；未取得的原始数据不补称已取得。所有复现使用本地独占 schema，不连接现场或重发旧提交。

固定 21aa 源码已确认：两条 QC INSERT 省略 checked_at；预算绑定显式 new Date；批量报工 SELECT 使用 CURRENT_TIMESTAMP；开裁完成身份表省略 completed_at；发厂窗口使用首次合同 generated_at 墙钟。探索报告仅实际触发了 Root 批报并确认源码路径，不把 UI 审计头当秒级业务 completed_at 取证。

## 时间类型与不可混用规则

| 类型 | 权威来源 | 写入/读取规则 |
| --- | --- | --- |
| 业务发生时刻 | 原资源绑定场景经启动 guard/原 UAT/范围解析验证后得到的 BusinessClock；无场景为真实时间 | 同一次业务命令取一次；瞬时字段与依赖锚点沿同一时域。只能向前的新场景操作不等于自动完成。 |
| 审计登记时刻 | 数据库真实 CURRENT_TIMESTAMP、真实服务器时钟 | created_at、recorded_at、terminal_recorded_at、PDF generated_at、附件绑定/操作事件登记时间保留真实值。 |
| 安全/运行时 | 真实时间 | 会话、控制码、幂等过期、PDF generating 五分钟抢占、网络超时、模板生效时间不随虚拟时间。 |
| 日期型业务边界 | 本单可信 businessToday/asOf，按 Asia/Shanghai | 日期截止为北京时间次日 00:00 排他边界；瞬时完成等于截止算准时。日期型不是无截止，也不捏造 duration 起点。 |

保留 SystemBusinessClock、ContextBusinessClock、启动隔离 guard 和 ALS。HTTP 入口先用原生稳定 ID 经 clockRoots/clockRequestIds 解析源/母单，实际绑定场景唯一且没有混入非测试资源，才允许原 UAT 身份进入锁内 ALS；header/客户端日期不是时钟权威。原场景绑定不可重绑。普通无场景订单继续真实时间。

## 逐入口链路冻结

| 入口/来源 | 场景解析 | 业务写入与数据库默认/trigger | 事件与依赖 | 投影/扫描/列表/UI | PR归属 |
| --- | --- | --- | --- | --- | --- |
| POST /digital-production/orders/:orderId/factory-flow/qc；旧整款与 workflow-v2 批次 | orderId → 原母单；批次/PO 必须属本母单 | digital_factory_qc.checked_at 当前省略而落 0230 的墙钟默认；改为同命令一次 businessNow 显式参数。回仓/裁床下界仍检查，附件审计保持真实。 | 首次检查表示检查完成，需处理不等于合格；允许先发仍需原原因/安排。firstRelease 决定仓库窗口，不能用质量放行替换检查完成。 | factoryBatchLedger → factoryBatchTiming → factoryTaskTiming → deadline revisions → 原任务/待办/FactoryFlow/SLA座舱；24h 从合法 QC 放行与首次合同业务 ready 的较晚时刻开始。 | PR1 |
| POST /sourcing/cases，携 digitalBudget | 母单及 PO 原 ID；不依靠款号 | bindBudgetSourcing.business_recorded 当前 new Date 与冻结业务时钟冲突；显式沿一次业务发生时间。日期输入原校验不改。 | case、款色、transition、child link、预算准备任务条件/完成、幂等回执同事务；失败不留半单。 | 原外发申请任务 → IE/供应链/老板三段，预算版本和原起点不重置。 | PR1 |
| POST /work-tasks/:workTaskId/reports；POST /rework-orders/:reworkOrderId/work-reports/batch | 原 workTask/rework 原生子单 → 母单；批体全部任务解析并核同单/同场景 | 单报已显式 businessNow；批报 completed_at 当前 SQL CURRENT_TIMESTAMP。改为整批一次取时，所有 capability 分组复用该值。 | 原 work_report.submit 操作事件保持真实登记；提交记录、成员分配、退回重报关联及后续节点原事务。 | N04/返工作业完成事实 → N05/N06/工资读；不以审计头代替业务完成时刻。 | PR1 |
| 原裁床实裁/更正 → completeBulkCuttingWithClient | cutting 子单/PO → 母单 | task.completed_at 已取 at；0229 digital_bulk_cutting_completions.completed_at 当前默认墙钟。插入复用同一个 at；旧不可变 trigger 不改。 | 任务完成、完成身份、后继事件与 route 建立同事务；有工艺物流下界及无工艺发厂起点必须一致。 | 原开裁任务 → FactoryFlow route → 工艺/仓库窗口 → deadline revisions。 | PR1 |
| 合同 generate、补资料、内容修订/refresh、首次老板批准后生成；启动 resumePendingContracts | sourcing case 原 child link → 母单；无关联普通单用真实时间；背景任务须从已验证 reader 得到本单时间 | sourcing_contract_documents.generated_at 保留 PDF 真实生成审计。追加每文档一次、可追溯的业务 ready 事实；绝不回写已应用 0207/0228 迁移或旧合同。 | 仅实际成功 ready 的事务写 ready 事实/操作事件，关联原 PDF/文档/场景版本；首次合同满足依赖时刷新原发厂 deadline。重试/下载/后续修订不重启已开窗口。 | 原首次成功合同身份保持；窗口改读其业务 ready。旧普通合同可保留既有真实 generated_at 口径；旧场景合同无可信业务 ready 时 unknown，不能取当前场景 now 回填。 | PR1；独立回签48h留PR3 |
| /production-reporting 日报、追加、完成、发货 | 当前 hook 漏该前缀；后续沿生产单→母单解析 | business_date/shipped_on/transitions/shipment 与0236墙钟上限需完整改造；数据库必须验证原绑定/原事件/UAT/clock version，不能信 GUC/JSON | 原数量/派单下界/工厂负责人/版本/先完成后发货保留 | 本单 businessToday/asOf → 表单 default/max 与原 SQL 上海日期一致 | PR2；PR1仅登记边界 |
| 合同首次 monitor、重签 cycle、有效回传、提醒 | 原 case/文档/批准快照/母单；普通单保持真实 | 0207 due CHECK、0228 cycle/generated_at=document.generated_at 原契约需先做兼容 schema；旧 PDF/回签不重写 | 独立48h、上海周日停表、首次不重启及历史豁免保留 | facts/详情/列表/筛选/扫描统一观察时刻 | PR3；PR1不改48h口径 |
| 板房列表、原生历史及附件、SLA坏单/好单、日期型任务摘要 | 每任务按原单时钟；列表实际快照时刻分开 | 原审计列不改；历史业务 cutoff 不能比较墙钟 created_at/bound_at | 同业务秒仍需终结事件、可信真实顺序与历史附件ID；未知继续未知 | 仅分类可证明的投影不一致隔离为不可评估，不吞DB/权限/隔离/未知代码异常；局部可证明风险保留 | PR4 |
| 原导航/文档类别/预算占位/生产返回/责任显示 | UI 使用真实 resource kind/id/version 与身份key | 不新增假实体或当前人责任事实 | 取消一次恢复合法 URL/草稿；迟到响应不能复活旧详情 | 已确认显示规则保留，不重做风格 | PR5 |
| 官方下载/依赖/构建/备份/更新 | 固定工具和目标SHA、实际挂载/DB/身份/当前运行 | 前置峰值预算、保留旧版、可恢复证据；不自动删除/扩盘 | 原官方入口、备份校验和重启稳定路径 | Python3.6/Node22/npm10/PG13.23兼容，既有裁床账号仅只读验证 | PR6 |

## PR1 最小合同业务 ready 事实方案

追加迁移，按文档保存一次业务 ready 时刻、完整 BusinessTime（scene/revision）、原文档/PDF身份及原操作事件引用，并保留真实 recorded_at。事实只在该文档首次真正变 ready 的事务追加，不从 GET、历史下载或现场坏样本补造。文档成功 ready、ready 事实、原发厂 deadline 刷新失败时须同事务回滚；PDF 生成/存储及原批准事务的既有阶段边界保持，不将已提交批准误称回滚。

新事实在原 case 锁内记录首次成功 ready 标记，以原事务事实确定该文档身份；遗留合同仍保持原生成审计顺序。再读该文档业务事实，不能选后一次修订的时间替换已开起点。背景恢复必须先安装经过启动 proof 的 clock reader，再处理 pending；生产配置仍不启用 Acceptance runtime。绑定场景而没有可信 reader/匹配时钟证据时拒绝写入，不能静默落墙钟。

不改独立合同回签 monitor/cycle 的48h、Sunday计算及旧审计列相等约束；它们在 PR3 完成前仍是单列已知缺口，不因为 PR1 的仓库锚点正确就宣称合同回签场景链已通过。

## PR1 回归矩阵与完成标准

1. 过去、接近当前、未来的独立初始场景与普通无场景单；场景创建后只向前，不修改旧单历史或全局 Date/OS 时间。各业务时刻与真实审计分别断言，跨场景/测试与普通混单拒绝。
2. 旧整款与分批 QC：回仓下界、多个 PO 同次时间、需处理/合格/合法允许先发区分、QC完成与放行分别取原事实；QC→24h仓库窗口→deadline revision/原待办读一致。
3. 无工艺和有工艺：task 与 cutting completion 使用同一个 at；下游物流不得早于实裁，有工艺按对应回仓/检查开窗，无工艺按真实切完与首次合同业务ready较晚时刻。
4. 合同ready早于/晚于QC或cutting、过去场景、背景恢复、首次失败/重试、同文档重新生成/修订/下载及后续版本：已开起点不重启；旧场景缺事实保持unknown，普通历史真实口径保留。PDF generated_at/附件/审计仍真实；原Sunday/48h规则不变。
5. 外发申请同key成功/响应丢失、不同key重复、绑定任务失败注入：case/款色/transition/link/准备任务/幂等回执核原子性与重试；预算/数量/日期及权限负例保留。
6. 单报/批报、跨capability分组一次取时、Root代报/工人权限、退回重报/数量、同key/不同key/失败回滚；有效作业完成及后续评价引用业务时刻，审计和幂等过期仍真实。
7. 本地 PG13.23 与 PG16：完整原schema/原trigger及低权限标记测试库；只清本轮owned schema，不清旧TEST事实。追加迁移静态/升级及现行Full适用检查；最终Head与独立Review/CI分别核。

禁止本PR修改已应用迁移/checksum、权限/安全守卫、其它五PR功能、现场状态、真实订单或生产配置。最终组合在六PR完成后再统一冻结并重跑所有新增/受影响矩阵，最后仅一次Acceptance更新由用户执行。

## 全范围入口及消费者责任清单

本节是语义责任清单；同目录 `acceptance-time-sites-20261027.json` 是原路由、墙钟调用、BusinessClock、SQL 默认/组合锚点、日期控件的逐源码候选索引。每条候选含路径、行号、类型和该行 SHA256，可回到源码核对，检查脚本会发现新增/删改候选。候选的 `pending-per-entry-review` 明确表示**未逐条语义核定，不是接入通过**；文件级 PR 仅是初始归口，混合文件以本表的业务链责任为准。扫描不是全链证明：隐式 SQL 默认由业务列写入守卫补充，跨字段 MAX/历史消费者仍需人工核和原生回归。未在本 PR 验证的各行必须在所属 PR 更新证据，六 PR 最终组合仍有 pending 时不能宣布全面完成。

| 原入口/分支及关键源码 | 分类、clock、原归属及依赖消费者 | 当前证据与后续责任 |
| --- | --- | --- |
| acceptance-clock/hooks + scope；所有原 digital-production/sourcing/cutting/receiving/rework/work-/pattern-room 路由 | 安全范围解析保留原 ID → 原 source/order 绑定、有效 UAT、唯一场景锁；请求 header 不是时间权威。普通/未绑定单为 SystemBusinessClock。 | 原启动 guard、ALS、混场景/混真实单拒绝保留；当前 Acceptance 原生回归待本 Head 重跑。PR2 补 production-reporting 前缀。 |
| acceptance-clock/runtime/repository/control-service | 场景 initial/business_now 为业务时刻；created_at、版本操作审计、扫描 started/finished 为真实登记。只向前及控制码规则不改。 | PR1 过去时间仅通过全新隔离夹具初始条件，绝不修改旧现场时间。预览/advance/scan 原范围负例随原生 clock 套件复跑。 |
| identity-routes/identity-service：开发来源、直接母单、源转母单、复制输入 | 业务 orderDate/原创建时刻、原配置版本取场景；资源创建审计真实。只能本事务新资源绑定。 | PR1 新增夹具使用原服务/guard；不增加历史绑定能力。完整 source→order/复制回归复用现有 clock 套件。 |
| development-routes/development-round/execution；旧板房联动 | publish、route facts、材料退回补正、纸样/车板/尾查/寄样/客户确认属于业务事实；审计登记不变。任务条件/依赖 MAX 只组合业务时刻。 | 已有 clock/补正修复保留；原生开发回归在 PR1/最终组合重跑，历史资料 cutoff/列表观察归 PR4。 |
| budget-routes/budget-service；预算准备 → sourcing-routes/createCase | published_at、准备任务 business_recorded/完成属于业务；保存审计真实。冻结预算/款色/transition/child link/条件/幂等同事务。 | PR1 修复一次取时；过去/当前/未来/普通、失败回滚、同 key/不同 key已加入新增 PG 回归，最终结果见本 PR 测试记录。 |
| sourcing-routes/SourcingService：IE报价、供应链、老板、退回、更正、调价、选厂/转厂 | operation_events.created_at 与旧 transition/decision 默认登记为真实；业务消费者须读取事件 acceptanceClock.now，再按原无场景历史兼容。不可把所有 transitioned_at 改场景。 | PR1 未改审批权限/金额/状态；原生外发套件完整重跑。历史投影中直接墙钟 cutoff 归 PR4，合同回签归 PR3。 |
| po-factory-date-adapter → po-date-repository → sla-po-date-adapter | 日期型 factory/customer date 与业务 revision 的 BusinessTime 分开；经 ContextBusinessClock 按原母单取时。审批/审计真实。 | 已有老板批准注入修复保留；scope/revision 不回退及普通单由既有原生 clock 套件复跑。 |
| bulk-preparation-routes：预派/派交、验布、预缩/纸样/唛架、材料发出；原 legacy 与 parallel | 布到/验布 occurredAt、业务完成/条件按本单 businessNow 校验；dispatch.changed_at/上传登记为真实。actual receive 与自动可办不等价。 | PR1 原生 parallel 有/无工艺夹具经过原角色、数量和 UAT 检查；legacy 分支兼容由原生 sourcing 套件覆盖，不能冒称所有 legacy 场景都走过。 |
| cutting-routes/CuttingService：单 PO 实裁、更正、整款汇合 | 实裁登记审计真实；task.completed_at 与 bulk_cutting_completions.completed_at 同一次业务 at；MAX 后继物流锚点不可再引入墙钟。 | PR1 显式补完成身份时间；冻结三方向/普通、有无工艺及同 key实裁复用已加入新增矩阵；Root更正/权限保留原生套件。 |
| factory-flow-routes：legacy QC、batch QC、复查、需处理、允许先发 | checked_at 为业务，checked_by/图片绑定审计真实。下界必须原回仓与裁床实际完成；检查完成不等于合格/可发。 | PR1 两 INSERT 显式业务值，新增矩阵验证 batch；legacy 真实路径由原完整套件验证。原生 scope guard不改。 |
| FactoryFlow logistics/dispatch/material/productionQC/shipSample/packing/close | occurred_at/完成事实为业务，工厂/回仓/数量/顺序原守卫保留；日期型船样边界按上海日期，slaHours=null不是无截止。 | PR1 只处理所列 QC/裁床/合同依赖；其它现有入口原生整链回归；船样 header/时间 quality与人员缺失分离归 PR4。 |
| factory-batch-timing → factoryTaskTiming → task deadline revisions → 原待办/SLA | QC firstCheck、firstRelease、首合同业务 ready、实裁完成各有语义；max(QC放行或实裁, firstContractBusinessReady) 后才开24h。缺任何必要事实为unknown。 | PR1 验证合同先就绪与延后就绪、无工艺/工艺、失败后再生成、首次不重启；不能用当前 scene now 补旧 ready。 |
| 合同 prepare/generate/supplement/content/style/template refresh/转厂重签 | PDF generated_at、文件 ready/上传/绑定为真实审计；只向原生母单合同追加 business_ready_at + 原 PDF/hash/event/clock。独立外发合同不纳入该发厂事实表。 | PR1 原 ready事务写 immutable事实；后台恢复前安装reader；后续版本/重试不重启首窗口；独立回签未改。 |
| server.resumePendingContracts；异步生成、存储失败、重启恢复 | 背景不借当前请求场景；ContextBusinessClock按原case→母单读取已验证reader，写入时DB再核原绑定/UAT/version。generating过期5分钟与网络timeout仍真实。 | PR1 后台无 ALS 生成及失败回滚已纳入；生成/物理附件成功但业务事务失败保留真实文件审计，原重试去重复用不伪装成无文件。 |
| /production-reporting detail/write/daily/append/complete/ship；production-reporting-service | business_date/shipped_on 是上海日期，transition/shipment业务事实须同原 production→母单场景。created_at/recorded_at为真实。 | PR2未实现/未验证；追加迁移替换0236墙钟上限但不改旧文件，DB proof不信任任意GUC/客户端JSON。 |
| production-reporting-page 表单 default/max/完成/发货日期 | 本单可信 businessToday/asOf，不能浏览器本地newDate作为场景日期上限。 | PR2待实现；北京时间日终±1ms、普通生产未来日期拒绝、派单下界/负责人/版本/数量/先后矩阵待跑。 |
| contract-return-state/return-service/monitor/return cycles；原合同列表/筛选/提醒 | 回签观察/有效终点为业务；PDF和上传审计真实；原48h、Sunday上海停表与首次不重启、历史豁免保留。 | PR3未实现；先兼容0207 due CHECK和0228 cycle.generated_at==doc.generated_at，旧合同不重写。 |
| work-reporting-routes：单报、批报、Root代报、临时工授权代报、退回重报 | completed_at业务；created_at/事件/幂等过期/委托有效期真实。同批跨 capability组一次取时，原数量与身份守卫保留。 | PR1 新增原生订单→实裁→收货→返工→人员方案→批准→分配→两个capability组批报；失败第二组/并发同key/权限拒绝/单报Root代理均纳入。退回重报/工资不覆写保留完整原生返工套件。 |
| receiving-routes → receiving-link-adapter → garment receipt/rework | 收货业务完成/garment后继事实沿原cutting生产身份；received_at/附件审计不可盲改，原生业务消费者需要明确来源。 | PR1新增返工矩阵用原cuttingID/原生收货和原child-link，同事务新子单 guard启用；历史和列表消费者逐项待 PR4核。 |
| SLA read/preview/commit/application/evidence/notification scan | 观察asOf按原单ContextBusinessClock；plan/fact recorded_at真实。scope/revision/time不回退、冻结参数/原起点保持。 | PR1不改变参数和已开标准；原生SLA/clock套件重跑。坏样本隔离/unknown风险统计待PR4，不能吞DB/隔离/未知异常。 |
| PatternWorkspaceTask、legacy-pattern-workspace、pattern order-reader/workspace-query | 逐任务业务asOf与列表真实快照asOf分开；列表SQL CURRENT_TIMESTAMP不能当所有场景now。 | PR4未实现/未验证；混多个场景+普通单、单单/列表一致性待跑。 |
| sourcing/rework/pattern node-history、history-scope、附件历史 | 业务cutoff与真实created_at/bound_at不可直接比较；同冻结秒须可信终结事件顺序/历史附件ID，不读当前资料兜底。 | PR4未实现；同秒多事件/节点结束/追加附件/授权/缺证据unknown矩阵待跑，不回写审计列。 |
| notifications/todos/delivery-worker/reminders | 业务deadline与扫描观察按原单/场景；网络重试、outbox审计及delivery timeout真实。acceptanceIncludesNative只处理当前原场景。 | 原提醒去重/投影守卫保留；PR3补合同观测、PR4核列表/坏单隔离，最终组合复验扫描。 |
| digital-workspace-navigation/router；文档筛选与returnTo、预算placeholder | 导航URL与实体kind/id/version为状态而非业务时间；dirty取消恢复一次。不能生成假budgetId。 | PR5未实现；refresh/Back/Forward/dirty取消/旧请求迟到/身份key矩阵待跑。 |
| production返回列表/晚响应；N05 currentOwner/header | 视图请求身份/订单/工厂版本key必须一致；前置条件、责任岗位与实际人员分开，不伪造当前访问者。 | PR5未实现；未知提交恢复idempotency状态保留，原已确认财务显示规则不改。 |
| auth/control-code/session/identity/access/root/bootstrap/authorization | 安全时间：会话/控制码TTL、雇佣身份、委托有效期、权限审计全部真实；BusinessClock不得接管。 | PR1无权限规则/数据修改；本地仅标准原始入口建隔离身份，额外代录授权仅存在owned fixture；现场裁床账号不操作。 |
| tools/attachments/object-storage/PDF/export/idempotency | 上传、绑定、文件生成、导出登记/签名URL/超时/过期真实；历史业务消费者仍单独核。 | PR1保留真实生成审计和存储去重；附件历史归PR4，不全局替换newDate/SQL CURRENT_TIMESTAMP。 |
| wages/finance/management reporting/sample独立模块/全局聚合 | 默认真实审计/账期或独立日期型业务，不因一个请求scene header把全局改钟；是否受原母单绑定影响需沿真实关联逐项确认。 | 未纳入本轮业务变更的候选明列待核，不能按文件名自动称安全或“已适用”。发现新业务接入缺口需报告边界后归类，不盲混入PR1。 |
| scripts/deploy/acceptance官方工具/诊断/更新/备份/容量 | 系统真实时间与实际挂载/体积；固定工具/目标SHA、当前运行、备份校验/恢复证据，不使用场景clock。 | PR6未实现/未验证；Node22/npm10/Python3.6/PG13.23兼容及下载/依赖/构建前峰值预算待跑；不自动删备份/扩盘。 |

### 防回归检查的精确能力与限制

- `check-business-time-writes.mjs` 对全 API 源码 AST 中所有四张受保护业务事实表的 INSERT 检查显式业务列，并拒绝该 INSERT 使用 SQL 墙钟。它能发现新增旧路径、批量 SELECT 或隐式默认绕过；不会把审计、安全列改成业务时间。
- `time-site-inventory.mjs` 冻结原路由及 raw clock、BusinessClock、SQL组合锚点和日期控件候选；新增/删改候选需要明确更新目录及语义清单。它不会证明某个参数来源正确，不能替代原生过去/当前/未来/普通时间和事务回归。
- 目录中的后续 PR pending 不算通过；PR1只对自己的实际测试结果负责。六 PR 最终合并树仍需重跑本轮所有新增/受影响回归与 PG13.23/16兼容，不能拿最后一个PR的diff Gate代替累计验证。

## PR1 首次 Head 6756695b 本地验证记录（2026-10-27）

运行工具为 Node 22.22.2、npm 10.9.9；实际隔离 PostgreSQL 为 13.23 与 16.15。数据库均先核低权限测试角色、精确数据库身份及 `dx-rework-isolated-test-v1` 标记。新夹具使用全量当前 schema、原受支持标准 UAT 初始化入口及原单裁床入口，全部原授权/SQL trigger 保持启用；业务调用均为本地隔离 fixture。开发“最终设计确认”是明确种入的新夹具前置事实，其后的产前、外发、裁床、收货、返工、人员方案、批准与报工走原生服务；不声称这一前置替代了开发全链或浏览器验收。

| 实际检查 | 结果与精确覆盖 |
| --- | --- |
| 新增 business-anchors-clock-postgres，PG13.23 | 18/18通过；过去/当前/未来/普通 × 有/无工艺8项，单报/Root代报4项，跨capability批报4项，首ready回滚/后台恢复/晚ready/版本不重启1项，预算绑定整事务回滚/重试/重复保护1项。 |
| 同新增矩阵，PG16.15 | 同18/18通过；不是用PG16替代PG13证据。 |
| 补强首ready scope/version/time 接错拒绝 | PG13.23与PG16.15均定向通过：错误scope、旧revision、错误业务毫秒均无ready事实/成功业务事件残留，合法后台无ALS重试可完成；原SQL守卫不降级。 |
| 原外发 sourcing-pr03-postgres，PG16.15 | 最终完整140/140通过。初轮139通过/1失败是合成独立历史合同改主键撞新增FK；新事实限原生母单后，该项定向通过，随后完整140项重跑通过。没有删除历史或放松FK。 |
| 原 full-business-chain + acceptance-sla-clock，PG16.15 | 串行83通过/1原有条件跳过；跳过项是未配置 ACCEPTANCE_CLOCK_BROWSER_URL 的原隔离浏览器HTTP用例，不算已测浏览器/现场。首次并发轮83项通过但member-module夹具清理报 out of shared memory，该轮失败保留；改为与CI相同的串行后全部套件及清理成功，未改PG配置或仓库门禁。 |
| 迁移兼容原12历史入口，PG13.23 | 12/12通过；main/release历史、空库、中断历史升级至0263，原身份/历史checksum/原timestamp/业务哨兵保留。PG16全新schema通过新增原生矩阵；PG16历史升级另由本Head Full Gate核。 |
| 全部单元测试 | 481文件、2521项通过，含新增4项业务写入/候选目录守卫与5项旧合同缺证据/普通历史/不匹配scope或时刻拒绝测试。 |
| 类型、构建、静态检查 | 全工作区typecheck、API build、全仓lint、migration manifest/checksum静态检查通过。 |

原现场坏TEST事实和deadline revisions未动；本地通过不等于现场补验通过。PR1最终Head的远端Full Gate与一次Codex Review仍须独立记录后才按授权合release；本节不提前声称CI/Review/合并/部署完成。其余五PR仅列责任与待验矩阵，未创建或施工。

## 唯一一次 Review 的 P2 与收口验证

首次 Head 6756695b40e47f160e27b1f495db341bed1728c2 的 Full Gate 40436878549 成功（包含新增18项、PG16历史升级12项、原完整数据库链29文件393项）。随后唯一一次手动 Codex Review 请求6432311834完成，finding r4384566937 指出无ALS后台生成持有事务连接/生命周期锁后，时钟reader再次从同一10连接池借连接的饥饿风险。未带问题合并，未另开Review。

本地先红：原生创建10份 generation_pending 合同，过去/未来两场景各5份；使用与服务端一致的max=10、connectionTimeoutMillis=3000。独立只读观察连接确认9个事务实际在等待advisory锁且业务池10连接全部占用，原生产代码使1份合同因 `timeout exceeded when trying to connect` 变成 generation_failed，其余9份ready。较早仅等待“10个连接忙”的版本没有稳定复现，未将它当红测证据。

最小修复：ContextBusinessClock增加内部可选的当前事务连接，只有调用方原服务事务传入；已安装reader仍先核启动proof并按固定resource kind/id查询原绑定，改用该连接执行原SQL。合同ready adapter传入它已持有的同池事务连接；ALS assertScope、普通无场景真实时间、SQL原场景/UAT/clock version校验均保持。没有扩池、加长超时、放宽事务/角色或吞掉失败。

修后PG13.23与PG16.15先各定向通过该容量用例：10份全部ready，事实逐份匹配原场景/业务时刻/revision，重复恢复不新增事实。随后受影响聚合（新增19项 + 原clock套件）在两版本各44通过/1原有浏览器条件跳过；PG13首轮还发现原clock夹具两处裸别名 `plans` / `at` 的语法问题，只补显式AS、保留全部断言后完整聚合重跑通过。全部单元481文件2521项再次通过；全工作区类型、API构建、lint、受保护写入/候选目录、迁移静态校验通过。

新增生产改动仅business-time/runtime/contract-business-ready三处连接传递；0263及其checksum未变。修复后新Head须重新通过Full Gate，6756695b的旧绿灯不能代替；Review次数仍为一次，完成发现闭环后才合release并开始PR2。
