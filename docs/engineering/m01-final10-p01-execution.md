# M01-P01 时间事实与进度读取修复

- 依据：十图最终施工方案 Version 2，Library `libfile_fde3_f-79e315fa20148191840c2bad583039f7_c8d3bf5d609c8191bce6411a30e94d44`，固定文件 `file_000000009f4c81fbaa74ab5bfebbf489`；全文643行与十张原图均已读取。最新用户授权两套方案施工、必要审查与逐个合并；全部完成后用户体验，用户负责部署。
- 目标分支：`release/digital-production-v1`；fetch后tracking ref及独立ls-remote同为 `3f96edb0f92afdd0667487e8c156904209f274b5`。
- 工作分支：`m01/final10-p01-time-facts`；隔离工作区 `/workspace/dx-rework-m01-final10-p01`。旧 PR05 草稿及测试资源保持原状，不整包移入。
- 范围：时间事实读取及同义契约、合法日期预测的自然时间比例、已证原动作事件写入/订正/撤销缺口、相关缓存新鲜度与针对性检查。风险为 FULL。首页/详情大布局、设置及日历按后续独立PR交付。
- 禁止：部署/ECS操作、生产或Acceptance真实业务数据修改、假补历史时间、扩大权限或审批职责、为性能关闭SLA/减少全局统计。图02两项错位须在P03修正，不能照抄。

## 已实现的事实链

| 有效范围 / 时间角色 | 原业务源与可信边界 | 读取、订正与缺证处理 |
|---|---|---|
| 开发任务：当前source/routeVersion/occurrence/taskId，实际发生与原责任D分开 | `digital_production_tasks` 当前有效时间/quality，`digital_production_task_events` 与原deadline revisions | `mergeJourneyNodeFact` 以key+instanceId+round+current核合并；undefined保留，明确null/撤销清完成元数据，非当前实例不串轮。原任务日志授权集合与展示records分别保留，继续原correctTime链，不改写历史。 |
| 无母单首版计划 | 原开发任务、bulk/factory/rework/garment/receiving/packing evidence；关联开发有独立计划也不代表母单已采用 | `SlaOrderService` 先读取原生来源，仍返回legacy_unenrolled；开发无SLA窗口的任务以原实例单独保留。监督仅附带有权节点的`nativeFacts`，timeRole=sla_observation明确不是物理出货承诺；不生成计划、D或SLA评价。 |
| 客户样板原确认：source+本轮，实际确认 | 历史route fact若从未存发生时间，仅有recorded_at不作实绩；新原确认操作同事务写payload.actualCompletedAt/timeQuality现场登记 | 原权限、准入和幂等不变；当前轮校验避免旧轮提交，新key重复也不重写第一次发生。旧payload缺时继续未知。Journey只取当前轮有效原事件。 |
| 客户最终评语+技术生效：source+轮+整款+客户+精确finalCommentRef | 技术生效只证明准入；精确评语`occurred_at`证明登记的客户发生时间，不使用review完成或recorded_at | 只沿effectiveTechnicalEvidence当前引用取值；显式occurred_at按recorded/unverified保留，不假作核实及时率。新评语待复核时清原完成；新生效评语没发生时间仍保持缺时。 |
| 唛架：当前preparation+fact | `BulkPreparationService.fact`原同步操作显式写businessNow到recorded_at；公开read已有同fact recordedAt | 从当前bulk.facts取“唛架完成”，不再只SELECT kind；前一preparation不混入本轮。原局部范围未完成时不写整单fact，原唯一约束及重复办理不变。 |
| 回货收齐：原母单数量规则、有效收货/更正/删除 | `receivingSpan`原操作回放；可信collectedAt，或原补录receivedDate仅date精度 | 新保留collectedDate，不填午夜或更正提交时刻；更正后才跨线和历史映射不完整仍未知。保留原receivingSummary母单数量口径及PO差异，不擅改该领域业务规则。 |
| 装箱：有效PO累计装箱修订 | `packingRevisionId/packingQuantity/packingRecordedAt`及原操作事件 | 已核recordedAt为保存/修订边界，不能无条件作实际物理发生。保留有效数量与原SLA适用性；Journey不编实际出货时间。原修订不足量后状态回退，不新增出货入口。 |
| 工艺/总查/发裁片：preparation+批次+lineIds | 原factoryBatchTiming的enteredAt/dueAt/completedAt/evidence/snapshotId | 保留`nativeWindows`三种责任截止，不写成forecast；现有单位测试核三项和错轮/不可见兄弟PO，原业务锚点PG为相关回归。历史M现场源ID本轮未提供，不冒称现场已重验。 |
| IE/决定/老板批准及返工/特批 | 原quoted_at/decided_at、任务事件/有效返工回合、closure.closedAt | 原正确来源和操作者保留；setFact不再默认擦除任务起点/截止/完成。特批不等于其余任务全部完成，不以关单或工资时刻代工序实绩。 |
| 预测 / 已采用计划 / 责任D | 原journeyBusinessDates三个独立字段组、SLA forecast/dependsOn/remaining及有效期 | 不以D/客户交期补预测。合法date预测用原slaDateBoundary北京次日排他边界作计算，显示仍保留date；起点只有日期而未定义计算边界仍未知。自然连续时间跨周末，原SLA日历不变。 |

## 缓存、契约与消费者

当前release的Journey复用是`reuseJourneySnapshotReads`单次单角色REPEATABLE READ只读事务内缓存（1024项/4MiB），事务返回即销毁；批量模板同范围同快照，不存在跨请求持久化Journey/时间摘要。原SLA/series保存的是采用配置及计划，不是可直接重用的计算输出，本PR不清空这些不可变历史。没有旧持久计算结果要扫描重建，不能为满足表格另造队列或全库任务。

本PR输出`journey-visual-v2`，合同保留v1兼容读取；后续PERF01/03的持久摘要键必须含本规则版本及各有效源修订，且保持成功保存后下一次主动读取的新鲜度。当前完成/修订/撤销后均重新开启权威快照；不会跨用户命中旧读。已读取到的nativeFacts是原SLA适配观察，注册时间不自动等于物理实绩。

消费者保持原链：原任务/节点工作区 → Journey task与原业务事实 → supervision → businessProgress/三个日期组 → visualProgress → 首页/详情。首页整单、详情阶段范围不同，字段语义一致；原n/m审计比例保留，视觉七阶段等权及各阶段有效小节点等权。原权限/角色失效、Root特例、no-store、全量统计、排序分页均不降级。

## 验证范围与已知局部缺证

- 实际运行环境：Node22.22.2/npm10.9.9、相同lock 80b0332e开头；独立worktree依赖、包产物。单元使用原vitest配置非DB单worker；PG使用原configForSuite对应原入口，普通PG单worker/long correctness配置2worker（本次一个文件），100秒正确性测试预算、原120秒初始化保持。Node taskset2,3不代表整台CI硬件等效；PG16.15为自有loopback低权限带TEST标记容器、2CPU/2GiB，既有PR05保留schema不动。
- 已先跑合法date预测17项；字段合并/实例/投影19项；监督/隔离/收货39项；随后组合101项及API类型检查通过。上述是分阶段真实结果，不直接当最终候选整体通过。
- 客户确认原操作专项与现代技术引用专项各1项PG通过，均真实原服务/原schema，非mock。客户确认保留重复、历史缺时、旧轮、无权拒绝；技术引用覆盖生效/新评语失效/无发生时间重新生效。
- 完整Journey原33项通过时新增legacy用例揭示：关联开发已计划但缺原SLA窗口的任务仍漏读。已修为无母单计划时独立读取原任务，定向反例通过。PMC严格查询夹具补原新增SELECT，保留角色允许/拒绝及不写数据的原断言。完整受影响PG及最终便宜检查现已完成，准确结果见下表与construction-evidence；不是远端Full或现场验收。
- `setFact`初次保留task record改变了原展示records，原PG指出后已修为分离authorizedTaskIds与展示records，日志可达且原records保持。新legacy合成夹具缺creation_hash已补，未改生产校验。
- 十图计划所引用时间审计2.2的原始分母/字段导出、N的34项具体ID/历史、F/B/C/M及双PO现场绑定未随材料交付。此处没有现场访问或数据操作授权；不编统计、样本ID、历史事件或现场已通过。已有源的通用投影和隔离fixture继续交付，现场复核留部署后按原来源核。
- 原独立SLA专项的实际分支/提交未提供，不假定其已施工。当前由本执行分支冻结既有等价时间契约；后续PERF03激活前须吸收真实已合并时间修复并更新受影响摘要，回退性能读取也保留时间修复。

未部署、未改Acceptance或生产真实订单；本PR未改大布局、设置或日历。最终远端Review、Gate、合并以准确HEAD/base回执记录，旧失败/跳过不写成通过。

## 当前组装候选的本地结果

源码指纹 `13acbfd1540fb485f9cdc0d17ccb1533c56a3bb416c42a17200921bb243d966a`，实际base仍为 `3f96edb0f92afdd0667487e8c156904209f274b5`。未改源码的类型及单元输入在变更前捕获范围指纹，后续仅测试夹具断言改变，按原协议复用，没有把旧远端Gate拼入新候选。

| 原入口 | 实际结果 |
|---|---|
| 14个相关单元文件（含旧PMC、实例、读取复用、业务/日期/工厂与新合并边界） | 169通过，0失败/跳过 |
| digital-journey-postgres，原完整schema | 34通过，0失败/跳过 |
| digital-development-execution-postgres，原真实办理入口 | 19通过，0失败/跳过 |
| development-technical-postgres，完整原生schema和独立TEST业务时钟库 | 20通过，0失败/跳过 |
| business-anchors-clock-postgres，原工艺/QC/发裁片和事务/时钟边界 | 20通过，0失败/跳过 |
| 原test:preflight | 249通过，0失败/跳过；迁移静态检查通过 |
| 全workspace typecheck、受影响文件eslint、API production build、secret:scan | 各exit0 |

预检先定位到原开发办理夹具直接建schema，已接入同一现有注册/创建/释放契约并重跑该19项，未削弱原测试或守卫；再定位到本次实际时间来源变化未同步候选清单，按原reconcile更新三项并保留旧人工说明，预检249项通过。不为清单格式重跑原业务测试。

最后复核加强了两个真实边界：多当前实例不附加假聚合节点；新瞬时订正不能被旧date字段优先遮蔽。新增合并单元反例及原真实外发任务/游标用例的双实例断言通过。双实例夹具曾误从仅返回taskId的创建回执取state，已改为读取原TaskService状态，业务断言保留。

所有自有进程组均已退出，各新建schema沿原精确契约释放。保留旧PR05 schema；不清理未知资源。提交后在全新检出复验，随后远端light/Review/最终Full分别核准确回执；当前表格不代表这些远端阶段已经完成。
