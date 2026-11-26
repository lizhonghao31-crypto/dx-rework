# 已落地的业务职责边界

本文只记录已经接入的代码边界，作为后续相关改动的入口；业务决定仍以领域规范和最新批准为准。不增加独立架构门禁。

## 已发布预算的洗水费用

`budget-washing-fees.ts`拥有原预算对象权限、当前主跟单／Root发布核验、生命周期锁、原确认报价上限、窄费用修订、幂等及审计；新版本只增加或调整指定洗水行，其他预算内容不接收客户端整表。`linkWashingBudgetFeeWithClient`独立核 financial对象及当前发布岗位，仅复制当前洗水安排改变费用引用，复用原计划持久化和覆盖重建，不绕管理层路线采用权限。`0293`对窄版本核原预算／PO、原报价依据和其他字段不变，普通预算发布守卫保留。

`BudgetWashingFeesPanel`复用原预算单据章节、字段和离开守卫；只读核对与写入串行，未知回执保留原正文和键。`budget-washing-fee-result.ts`核具体订单、PO、版本、引用与金额行后才显示成功。预算首次完成事实不因补费用重写，新费用发布和引用历史独立可查，已采用外发与合同仍指向原版本。

无外发关联时，费用发布更新原`digital_budget_preparations.budget_version`，保留原备办任务；有外发关联时保留采用版本。费用发布与原外发创建共用生命周期锁，原`readBudgetSourcing`继续严格要求当前版本一致，不放宽旧预算、图片及订单版本校验。

## 大货洗水真实返洗

`bulk-washing-ledger.ts`沿原有效事件集计算首次数量和各不合格检查尚未返洗余量，返洗仅在原`send`／`factory_start`携带明确`reworkOfInspectionId`，后续发收和检查仍用原父事件身份。`bulk-washing-service.ts`在原生命周期锁、当前指派和范围版本检查内核余量、幂等及投影，不能跨PO或用返洗增加实收；原不合格及所有轮次留在不可变账。`bulk-washing-windows.ts`由每个真实开始与洗回生成各自责任窗，Journey保留这些独立窗口，活动返洗不借旧完成冒充全部完成。`bulk-washing-actions.ts`只投影当前可办理余量，不是授权源；原页面保留错误撤销，但真实返洗有独立入口和轮次。费用及已发预算／合同不因次数自动变更。

## 开发实际发生与审批就绪（R5-02）

`development-occurrence.ts` 在原命令内区分本单时钟的现在办理、补登时刻、仅日期及未知；登记时间不替代实际发生。原开发服务拥有事务、权限、轮次和幂等，Journey 只读取同源同轮的有效事件，不回写历史。`journey-native-times.ts` 的开裁汇合只连接原生 task/PO/cut 首次就绪，不复制办理算法。

`sourcing-owner-readiness.ts` 检查原数字订单主跟单的当前合法办理条件；`access-service.ts` 的原人员指派事务释放明确等待该条件的老板审批。原外发服务仍拥有决定和操作事件，原待办服务保持分发、角色及幂等；已开始时钟不因再次指派重置。旧历史没有可信就绪记录时不推造新起点。

## 固定目标与独立工艺（供应链总看板 PR02）

`fixed-timeline-initial-input.ts` 在原来源/母单创建事务冻结标准身份；`fixed-development-adoption.ts`、`fixed-order-adoption.ts` 由原发布/产前准备事务保存实际范围、顺序和不可变输入。原服务继续拥有授权、锁、命令、幂等及提交，reader 不补写历史。默认 `legacy`；已采用 v2 按自身版本读写，关闭新采用不能改变其语义。官方安装环境的启用接线留六项集成完成时处理，本 PR 不启用现场。

`fixed-timeline-targets.ts` 只按传入冻结 DAG 和节点日历倒排。`fixed-timeline-adoptions.ts` 接入原有界事实 worker：先重建原 B0，再顺序回放真实批准且值改变的该 PO 客户交期。失败留原重试状态，不回滚已提交办理。`fixed-order-route.ts` 留存后续真实制单范围，`fixed-order-route-targets.ts` 仅为新增工作沿原交接约束分配目标，不重排旧 B。规划时长和独立责任标准分别保存；未知不推成零。

`fixed-task-route.ts`／`fixed-craft-steps.ts` 保存真实任务位置和工艺身份，`fixed-craft-timing.ts` 用原生前置与首个可信就绪事件计时。`factory-step-ledger.ts` 复用原不可变收发事实；下一道消费前道有效合格回仓，同件不重复计数。`fixed-factory-dispatch.ts` 在原底层发厂写入口再次核末道范围；表层隐藏按钮不能替代数量、质检和权限守卫。原 legacy 路线、RR 读取、私有附件以及分页/统计保持原职责。

## 附件复制

`tools/attachments.ts` 的 `copyDigitalBudgetImage` 负责预算来源、版本、操作者映射、订单事务与审计。只有未尝试提交且确认回滚的新对象可以清理；提交结果未知时不得删除。副本重试的私有对象核验在提交和释放连接之后执行，失败不自动修历史附件。原件、私有缩略图及生成后的最后鉴权由原附件入口负责。

## 请求身份与当前授权

`auth/service.ts` 负责真实会话、外部成员核验及当前本地身份装载。请求 proof 只保存会话／组织／身份及阶段的绑定，不保存 AuthUser、角色、Root 或字段授权结果；实际请求结束即释放，不能按 requestId、用户或 token 跨请求复用。

`auth/request-identity-context.ts` 是外发／供应商试点范围和阶段入口。两个写前 HTTP 守卫可共享 admission 的成功外部核验；handler 在原授权点明确 fresh；response 复用本次 handler 的外部 proof，继续读取本地会话、在职／启停、角色与 Root，并沿原字段裁剪。外部变化发生在最后在线核验之后且尚未反映本地时，同阶段可能沿用该 proof；下一请求重新在线核验，不宣称零撤权窗口。

试点只包含文件中列出的普通外发读取、纯数据库命令及供应商资料入口。合同／图片生成、创建及补图校验、转厂／合同换版等含远端等待后再写入的流程、附件最后鉴权、下载、导出、Lab 和其他模块保持原 fresh 路径。新增外部等待或改变授权阶段时，须在真实副作用前重新核验，不能因为请求尚未结束沿用旧 proof。复用 proof 不得再次 upsert 旧成员数据覆盖后来撤权。

业务服务继续拥有原事务、版本、幂等、审计及增量登记。提交后本地授权读取失败仍失败关闭，已提交不谎称回滚；返回敏感字段前继续裁剪或拒绝。未知提交沿已有实体、body 和原幂等键恢复，不发明新的通用回执平台。

## 外发详情的读取、人工提议与提交

`sourcing-detail-read.ts` 用单个已校验快照负责详情的原七项读取；实体生命周期与 GET 代次分别管理，旧成功、失败与收尾都不能更新新一代实体。取消仅用于原 GET，业务提交不因刷新而取消。

`sourcing-detail-prices.ts` 负责 IE、生产管理、工艺及转厂的人工提议、默认回填和原价格联动。回填完成后才能办理；手动清空仍是人工输入，不被刷新后的默认值填回。重新申请、更正和退回的本地草稿由同一个订单详情实体持有，同单查看历史不挂载可写历史表单，也不丢掉当前提议；离开实体和身份边界仍按原生命周期清理，不新增持久草稿。

`sourcing-detail-submission.ts` 复用原 `SubmissionAttempt`／反馈协调器，提交先捕获实体、正文、原版本及幂等键；读取快照不能覆盖人工草稿，结果未知只核对原请求。旧实体回执不修改新页或触发新页提示／跳转，已提交但刷新失败保留成功事实。退回、预算更正及财务差异的原生弹窗在内部呈现同一个原请求的核对入口；背景 inert 不影响恢复。退回确认后同单读回并沿原内部导航返回当前节点，不以整页刷新丢掉未确认状态。附件原上传恢复入口和回签原文件／绑定标识继续使用，不重传已完成附件。

`internal-navigation.ts` 只增加可选目标地址供原离开守卫识别同单切换，保留原导航、历史回滚及无参数守卫行为；这是协调方批准的窄兼容接线，不更改全站路由。普通浏览和自动回填不提示离开；实际未保存编辑离开实体才确认，未知提交留在原单恢复。

## 外发读取与映射

`sourcing-case-read.ts` 负责外发详情、历史和列表查询；`sourcing-case-mapping.ts` 负责原生查询行到外发契约的字段映射和大兴单价可见性判断。列表保留 `filtered_cases → page_cases → case_details`，完整筛选、计数和数量汇总先行，仅当前页补丰富明细。读取不缓存身份、权限或完整响应。

`sourcing-service.ts` 保留公开入口、参数校验、授权和全部业务命令，仍拥有事务、锁、幂等、审计和增量登记。命令后的详情读回显式传入原事务 client；读取模块不得自行连接、提交或释放该连接，原生时钟及历史批准版本继续沿原计算。读回失败仍由原命令事务回滚，不能从池外读取旧结果掩盖失败。

## 回货数量与看板读取

`receiving-quantity-query.ts` 保存唯一的原生数量聚合及普通、精确批次和数字订单范围。原生收货、补收、Root 更正、删除及数量版本继续共用原口径；未知装箱数量仍为 null，不折算为零。日历、数字订单结案直接读取这套 SQL；原服务导出保持兼容。

`receiving-board-query.ts` 负责看板参数、只读 RR 快照中的完整 KPI／当前页和原字段映射，不读取用户缓存或另建数量公式。`receiving-service.ts` 保留公开入口、命令事务、授权、幂等、审计及导出上限。装箱／差异处理仍在原命令事务、原样式／裁单锁和最新批次检查内取得 `styleOperationSnapshot`，不以页面旧快照替代锁内事实；分析继续使用同一数量聚合。

Root 从原收货批次更正款号时，`receiving-service.ts` 在锁内核对原批版本、记录审计及适用的数量订正，再以同一事务连接调用返工模块的 `correct-source-batch-style.ts`。返工操作只更新来源为该批、款号与目标不同的返工行。收货继续在原事务处理图片及装箱候选失效，任一步失败时整笔回滚。

## 仓库收料旧凭据

G4 将旧面料实收和辅料实物的材料指纹规则集中到 `preparation-material-repository.ts` 的 `legacyPreparationMaterialFingerprint`，保持原 JSON 字节格式。仓库列表在原授权的批量只读快照计算每条旧凭据的有效性及原因，原登记与历史仍从各自的授权、版本和查询上下文取资料。新式批据继续按原批次、物料、供方、单位及款色归属判定，原采购余额及发料资格继续由各自入口计算。已保存的旧指纹直接读取。

## 回货页面的读取与编辑会话

`receiving-board-read.ts` 负责原筛选、分页、只读请求代次、当前会话权限装载和展开状态；失败时清除不能采用的读取，旧成功／失败不覆盖新查询。`receiving-board-types.ts` 仅保存原页面数据形状，包含真实数量、未知值、批次与修订标识。

`receiving-board-edit-session.tsx` 拥有原装箱、差异、收货更正、批次更正和删除会话；五类弹窗共用唯一的原 `createReceivingBoardMutation`，关闭弹窗不丢失待核对的原实体、正文、版本和幂等键。仅重新读取不能冒充写入回执。上传继续使用原恢复工具和已上传文件映射；图片 URL 在移除、关闭及卸载时释放，不重传已完成附件。

`order-board-page.tsx` 保留原展示、字段／按钮权限、导出编排和 `ReceivingDialog`；不新增持久草稿、不重排 UI。服务端最终授权与数量判断仍在原入口，页面读取不覆盖正在编辑的快照。未知提交时禁用新写入，原核对入口在弹窗内或关闭后的页面保持可达。

## 开发执行读取装配

整件返做的原生轮次关联由 `development-native-round.ts` 依据原提交／发布事实和明确继承解析，不能用不断变化的当前轮替代历史关联。`development-round-service.ts` 需要重做车板时接原 `PatternRoomOrderService` 的同事务入口，完整保留本次修订资料；原服务继续负责返工状态、金额待核、派工、计薪、幂等和审计。旧尾查退回仅以该任务当前有效办理权及已保存退回事实触发待核价制作，不返回财务详情。车板完工和最终确认由 `development-route-service.ts` 核对同一原生轮，不能跳过实际制作而沿用旧轮完成状态。

`development-execution-read.ts` 负责开发资料、授权任务、轮次、材料、安排、技术证据与原响应的装配，明确原字段形状。只接收原快照代理 client、actor、sourceId 及资料／任务／技术／事实四项窄读取能力；不传整个 service，不另连池、开事务、释放连接或新建缓存。原 SQL、参数、调用次序和历史 tasks／routeFacts／facts 保留，不因当前轮规则裁掉历史数组。

`DevelopmentExecutionService.read` 继续拥有取得／释放连接、只读 RR、COMMIT／ROLLBACK，以及唯一的 `reuseJourneySnapshotReads`。资料、任务、技术和事实读取显式共用该代理；读取错误原样向上交回事务 owner。其余命令、生命周期锁、写前授权、幂等、审计、派工／核料／完成／转交和未知提交边界不迁移。原执行 GET、同单授权任务二维码和 `useDevelopmentExecution` 消费者不改；请求身份复用试点不扩展到开发模块。

## 后续维护

时间专项PR01：`order-time-framework.ts`契约保存明确范围、标准、路线、里程碑与正排安排；`readTimeFrameworkPlan`只识别旧v1及新框架版本，不自动升级或补日期。API同名纯模块复用原`buildOrderTimeWork`、`fixedTimelineForward`与日历，逐里程碑比较必要工作集合；普通读取不调用候选重排。新增提交下界及保留安排是可选输入，现有调用保持原行为。责任评价只接原生已进入窗口，不开钟、不写任务、授权或业务数据。正式采用和历史事实绑定仍由后续PR在原命令事务接入；本阶段没有新格式持久化写入口。

时间专项PR02：`order-time-completion-target.ts`以真实完成精度和同范围计划历史选择完成当时的有效目标，`order-time-reading.ts`仍使用原RR代理client；不查新公司标准、不以登记时间补造事实。固定进度保留当前目标与完成历史目标两种版本引用，历史偏差不能被事后改期抹去。`first-effective-receipt.ts`从完整有效正数实收范围判断首收精度；`factory-delivery-reading.ts`按原工厂/PO分配比较首收与当时承诺，首交与收齐分别返回。`OrderClosureService`沿原授权及收货更正账读取，现有物流、SLA消费者共用首收证据。未知时间、未明工厂归属或历史跨版均保留待核，不猜测首笔。原派生白名单补责任日历及完成目标，计算版本变化走已有有界重建；不写业务事实、计划或责任钟。

正式单继承开发成果时，读取器在同一RR代理上只补读一次真实关联源单的历史；转单前完成的工作按原源单、轮次、canonical工作身份及唯一原范围选取当时目标和非任务责任规则。正式单在发生时已有有效版则沿该PO版本，不能借用另一PO、轮次或后来源单的安排；原生任务／批次责任窗口仍优先。

尚未迁出的业务命令继续沿原服务维护；预算更正、装箱及差异等只有对应业务需求触发后才按 F5 核迁出，不扩展为全命令搬迁。纯规则／映射不依赖 React、Fastify、新连接或私自提交；已有事务 client 必须继续传入，不把同事务读回换成池外读取。

相关 PR 只需核对：职责放置是否正确，事务／权限／业务反例是否完整，是否保留当前按页读取、全量统计、敏感字段及性能边界。确需例外时在原 PR 说明原因、成本、风险与回退。回退本单元接线时保留图片不误删底线及已合并的业务、时效和 PERF01–12 成果。

### 供应链 PR03：有效装箱读取

`receiving-quantity-query.ts` 的 `RECEIVING_GROUP_PACKING_JOIN_SQL`/`RECEIVING_GROUP_RESOLUTION_SCOPE_SQL` 统一原收货组的当前累计head与有效处理范围；原ReceivingService继续拥有权限、组锁、写入、幂等和审计。`packing-actual-time.ts` 只校验/解析原入口显式发生时间，`receiving-packing-time.ts` 契约保留instant/date/unknown精度，登记时间不替代物理A。`journey-cut-scopes.ts` 共用原生身份谓词，结案和日历对歧义范围保留未知；`packing-sla-evidence.ts` 只从同PO质量/数量/时间证据形成物理完成，保留数量完成但时间无证的事实。现有Journey有界队列随计算版本更新，不在GET全库重建。

本批附带修复已复现的CI回执传输故障：三个lane的原始记录通过同run/attempt artifact传递，只把各job结果与bundle hash作为短环境输入；原Head/base、版本、完整计划、构建与清理核验不变，不减少业务检查。#956的最终汇总失败仍保留，不能称远端Full通过。

`readNativePackingHeads`对授权cut集合批量读取，包括已删除但未明确撤销的来源；不靠制造收货行让head可见。原Root累计写入记录当前合并scope事件集合，跨旧scope后的新累计须在同锁内确认。`NATIVE_EMPTY_PACKING_SCOPE_SQL`在同一RR内用原创建审计、子链与旧别名候选证明正常空范围，漏挂或旧来源候选仍unknown。尚不确证的历史多cut分配仍不猜；本批不自动改历史关联。

### 供应链 PR04：固定进度读取

`fixed-schedule-progress.ts`只评价传入的冻结DAG/日历和可信事实，分别计算可交下界、已赚提前、目标差、独立责任窗及整单物理跨度。`fixed-schedule-basis.ts`在原授权RR内复用原生来源/轮次、逐PO实裁、工厂、收货/质检/装箱和终止事实；共享存储只保存明确白名单，不保存用户结果。`fixed-rework-progress.ts`读取原批准和当前配置派工，新增范围目标只由原有界worker在原交接约束下补齐。`fixed-task-targets.ts`只返回已授权单任务自己的B，原task dueAt/D不变；计划缺失不回退成另一个时间。

`JourneySelectionClock`保存有限分类帧；`journey-selection-query.ts`在当前完整授权范围读轻量标志，`journey-projection.ts`保留原KPI母集合和15条富化。当前选中行才计算数值，GET不重建全库、不改B。原实裁事务仅为新v2原生PO/cut/record写真实分PO完成事件，Root原更正入口只更正该事件，不改兄弟PO或共享整任务完成时间。纯读取、原事务/权限、有限后台更新与后续UI消费职责保持分离。


### 供应链 PR05：成套标准与演算

`sla-settings-sets.ts`在原全局生命周期锁、当前授权及同一事务内协调两类原个人草稿和正式标准；`sla-settings-set-repository.ts`只保存真实组合引用与规划参数，不拼历史、不更新在途。原单侧发布仍走自己的服务与原权限，预览绑定两侧当前版本，发布后形成真实当前配对。PMC不读取未发布个人草稿。0283仅扩展既有组合/草稿记录，不做历史回填或新采用启用。

`fixed-development-work.ts`与`fixed-order-work.ts`是从原采用入口提取的纯路线构建器；实际采用仍由原事务冻结真实来源、范围、日历与标准。`sla-settings-calculation.ts`只把临时假设交给同一构建器和倒排算法，不连接数据库、伪造A或发布配置。`sla-settings-set-editor.tsx`维护唯一组合编辑/提交恢复协调，`sla-independent-calculator.tsx`维护独立临时输入和只读请求代次；客户跟单仍用原入口。`SeriesPlanService`保留显式采用和真实历史，默认profile/自动候选使用面已撤除。


### 供应链 PR06：统一数据的展示与导航

`journey-query.ts`只在授权富化结果附真实观察模式；`fixed-schedule-basis.ts`保留原任务D后再附冻结B，不更改任务或共享事实存储。`journey-visual-progress.ts`在v2使用已存在的固定目标和原物理交付A，旧单继续沿原日期语义；比例、KPI和分类谓词不重写。

`cockpit-fixed-schedule.tsx`负责原目标差/独立责任/物理跨度的紧凑格式和可见live数值展示，不调用API、不持有授权缓存、不写时间或状态。原`CockpitDetail`测量真实七行视口并在同一网格约束单据/记录，不强制固定短包装高度或把资料藏在上排内部滚动。`components.tsx`仅聚合原授权导航；`production-display-context.ts`复用原本地返回地址验证，填报继续走原服务的权限/提交恢复。

### R5-04：本单时间核心

`order-time-plan.ts`保存一份本单用时/日历/提醒及完整原公司对应项，`fixed-work-definition.ts`把新格式映射到原work职责；没有新格式的旧快照保持原值。`fixed-timeline-targets.ts`共用原DAG及计时日历完成正反向运算，内含交接不重复、并行取必要分支最晚，`order-time-schedule.ts`仅把明确适用路线和临时条件交给它，不制造R或A。

`order-time-plan-repository.ts`只接受原命令传入的同一client；原命令负责当前权限、合法工艺变更、业务锁和提交。0284逐版本追加冻结输入及B，原始公司对应项不被后来标准替换；普通调整保留既有B，新增节点首次求解。原PO批准改期适配器在同事务追加相关目标，采用当时有效本单版本，并登记原有界更新。这里不写任务、实际事件或已启动责任，不自连Pool、GET构建或新建定时器。正式采用、办理链和统一读取分别由07/06接入；中间版本不启用新建单格式。

### R5-05：设置与客户默认人员

`order-time-settings-service.ts`拥有公司标准的原角色鉴权、事务、并发及幂等；`order-time-settings-history.ts`只在同一client读取原版本与隐藏记录；`order-time-settings-calculation.ts`将临时输入交给现有图和日历，不写订单或虚构事件。新发布与采用一同在07启用，旧生命周期入口继续兼容。

`customer-merchandiser-defaults.ts`拥有客户批量设置及版本检查，`order-merchandisers.ts`只在新订单事务复制默认关系／授权读取后返回完整关系，`sourcing/additional-merchandisers.ts`保留外发旧单字段并读取、绑定全部副跟单。合同、待办、外发命令继续由原服务判权及提交，不把“副跟单”变成主跟单办理权。页面编辑、临时演算和客户弹窗分别管理自己的输入／提交恢复，不共用会串单的全局草稿。

R5-06 时间读取：`order-time-reading.ts`在原授权RR内连接明确本单方案与原生事实，`fixed-schedule-stages.ts`负责同终点阶段日期/差值；`fixed-schedule-progress.ts`保留目标、自己的责任窗口和整单缓冲的区分。普通读取不采用、重建或查询新公司标准；原事务登记/有限worker负责更新，客户端只按已证明的live时钟重读当前页。

### R5-07：本单申请与原生生效

`order-time-request-service.ts`拥有申请状态、版本、办理事务和原请求回执；`order-time-operation-state.ts`在同一读取client装配当前有效事实及原单已保存的拟变更，复用原路线、日历和Journey原生事实，不替代原业务命令。`order-time-request-plan.ts`只计算条件预计／下界、各PO剩余路线和真实适用行，不把演算日期当完成事实。`order-time-request-repository.ts`保存不可变状态事件和按真实操作者／正文／key的回执；一个人办结后其他办理待办随状态关闭。

`order-time-admission.ts`仅把已经锁定的合法申请绑定本事务实际client，原设计师仍是来源所有人，实际办理者仍是老板、Root或供应链总监；不更换actor、不缓存授权。`order-time-native-commands.ts`将该范围接回原开发发布、正式确认、内部复版及制单发布命令。原服务继续拥有资料／价格／技术／质量守卫、审计、幂等和提交。客户复版仍先形成独立未生效草稿，后续正式发布才采用时效；原生继承附件依据保留，不移动原件或允许无关订单引用。

首次新格式公司发布与新采用同次启用；已保存本单方案不依赖新采用开关。原正式生产继承来源已采用标准，普通调整不改旧B，批准客户改期沿原PO入口重倒推。`order-time-native-timing.ts`及原产前／工艺批次适配器在真实窗口打开时选本单版本，保留已开始的R、D、日历和提醒；`order-time-created.ts`只读真实创建事件，不以数据库登记时间、采用或刷新替代。旧窗口／未知历史保持原依据。

`order-time-todos.ts`只投影当前有权事项与轻量计数，不为角标演算整单。原页面的`order-time-application.tsx`接续当前保存资料；`order-time-request-page.tsx`负责本单输入、演算、单一提交、晚交确认及原正文/key恢复。正式写入、申请状态、方案及结果通知同事务提交；未知回执不能新key重复生产，正常页面没有额外审批中心或说明墙。

### Root 整单删除

`whole-order-deletion-service.ts`拥有当前 Root 复核、预览版本、请求幂等及每单事务；`whole-order-deletion-scope.ts`仅沿稳定归属 ID 收集母单、来源、PO 和原生子单，不按款号或供应商猜归属。`whole-order-native-deletion.ts`在同一 client 接回原外发、板房、生产排除、返工及收货逻辑删除审计，历史和共享目录不物理删除。`whole-order-visibility.ts`为原授权/候选查询提供精确删除过滤，不缓存授权或改全局统计为当前页统计。后台原有增量队列仅退休被删除对象的派生结果。

`cockpit-order-deletion.tsx`负责原座舱的预览、确认、逐单反馈与原请求重试；不替代服务端权限或自行处理业务数量。历史共享收货批次无法按明确归属拆分时，本单事务拒绝并清楚返回原因，其他独立批量项继续，不能把半删报告成功。

### 时间专项 PR03：自动报价来源

`quotation-assembly.ts`在原开发、技术、复版和指派命令的同一事务及生命周期锁内，按当前有效来源装配报价草稿；无新后台队列、独立事务或 GET 写入。物料身份、计价单位、有效技术版本和实际人员共同约束来源，不按名称匹配。`development-commercial-fields.ts`负责共享技术资料的价格字段裁剪，不替代原资源授权。

`quotation-service.ts`继续拥有逐行价格与用量权限、并发版本、幂等、审计及客户确认快照。`quotation-budget-basis.ts`继续拥有已确认报价与正式订单齐备后的唯一转换；后续采用、预算发布和合同沿原服务，不由自动汇集覆盖。特殊工艺库及阶段步骤由后续批准 PR 接入，不能用一个通用工艺行代替多步骤。
