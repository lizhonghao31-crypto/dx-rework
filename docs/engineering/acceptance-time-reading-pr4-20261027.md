# PR4：业务时间读取、节点历史与投影错误隔离

## 基线与边界

- base release/digital-production-v1：ee77a097248eb6aae2252415a13df033b88a017e；tree660364331a654d1734dfa1b6fa3d0376ff526abd。
- 用户于2026-10-27T07:56:21Z亲自合并#866，才建立fix/acceptance-time-read-history-pr4-20261027。#866明确Review豁免只适用于该PR，不延伸本PR。
- FULL；先入口/兼容清单、明确RED、完整修复、集中受影响回归、独立自查，再稳定push；所需Gate通过后才GitHub Codex Review，不并行抢跑审核。
- 不写现场，不改审计时间/旧migration/checksum，不清旧TEST，不改PR5导航或PR6交付。

## 实现前入口/消费者清单

| 链 | 读取入口/归属 | 修复责任与保持项 | 必须验证 |
| --- | --- | --- | --- |
| F8板房工作台 | DevelopmentWorkspaceQuery.pattern → patternTasks → PatternWorkspaceTask → DigitalPatternWorkspace卡片/预览/风险/表格 | 每task保留原Journey业务asOf；列表asOf仍是真实SQL快照。缺失/倒序时间明确待核，不按墙钟补算或负数归零。 | 同列表过去/当前/未来/普通；完成终点冻结；未进入/缺失/负值；全部视图/分页/权限不扩 |
| X-HISTORY原生节点 | PatternRoomOrderReader授权后的event/round/segment/attachment → patternOrderAtNode →原历史页 | 业务cutoff只描述本轮节点终结；按真实终结event身份及可信审计顺序回放，附件必须同时受历史事件ID与原授权约束。不能把created_at替换为虚拟时间，不能用当前资料兜底；同真实审计时刻无顺序证明则unknown。completed历史也不借当前详情冒充快照。 | 同冻结业务秒多事件、后改资料/后附件、跨轮返工/交接/取消、真实审计同刻歧义、缺终结证据、旧普通历史、各角色/工资/价格mask |
| SLA读取错误隔离 | SlaOrderService公开read、Journey整单/来源监督、列表/搜索/导出与指标；SlaOrderApplication命令保持strict | 仅显式分类的已授权事实投影时间矛盾可按节点显示不可评估/原因；严格计算默认仍抛错，命令不降级。DB、权限、scope、未知错误原样抛出；保留请求编号、好单和可证明局部风险，指标不把unknown当正常/零。 | 单单/坏+好列表/筛选/总量一致；已完成与未完成；节点/批次；异常不吞；strict命令拒绝；角色与原P09/P10读取 |
| 日期型任务 | DigitalTask DTO timingMode/dateTarget/dueAt →原DigitalTasksPanel摘要/历史 | date_target无slaHours仍显示日期截止；不补duration起点。主办与时间依据分别显示，未知起点不冒充人员缺失。 | 截止前/等于/后、北京时间日终±1ms、日期缺失/普通duration/无限时限；原人员权限与时间修订记录 |
| 时钟与安全 | 原source/order绑定、ContextBusinessClock、真实读取快照、日志分页和错误响应 | 不给全局列表套单场景；已有事务复用连接；审计/认证/session/TTL/网络超时仍真实时间；业务日志与历史边界分开核。 | 多场景/混单拒绝、无ALS读取/满池；日志稳定分页与权限；未知错误requestId可见 |

## 冻结最小设计

1. 板房新增逐task业务asOf字段，保留列表审计快照；页面只用逐task时间。
2. 原生历史优先识别本轮对应终结action/event，再用真实审计顺序及历史附件ID重建。原事件字段不改；未证顺序/缺材料仍明确unknown。已授权detail是可见数据上界，回放只收窄。
3. SLA严格评价保留，读取端只隔离枚举的事实时序错误，并让受影响节点的预计传播为unknown；其它有效节点/业务进度及局部风险保留。写命令继续strict；拒绝泛化catch、clamp、丢单或把unknown当零。
4. 日期目标展示独立于duration，时间依据独立于人员身份。

以上是实现前冻结清单；已实施与本地证据见下文，未把它当作全轮验收结果。PR5/6未开始。

## 逐入口落实（PR4）

| 入口/消费者 | 时间分类、归属与实现 | 未改变的边界 |
| --- | --- | --- |
| Journey read/list/search/export、旧工作台摘要/分页 | project 按原 source/order 查询 ContextBusinessClock，使用已有快照连接；每任务 asOf 由该 journey 保留。snapshot 的 CURRENT_TIMESTAMP 和日志分页 cutoff 仍为真实审计时间。 | 板房窄范围不新增整单 SLA/财务读取；旧普通列表与原工作台的风险/分页语义保持一致；不借列表墙钟补逐任务观察。 |
| 已授权整单/来源 SLA 单单与座舱列表 | SlaOrderService.read 和 readJourneySupervision 显式选择只读投影评价；SlaOrderApplication 的 readWithClient 默认 strict。只枚举 completion_before_start / actual_after_observation，节点和原生批次同规则。 | 不 catch 未知异常，不处理为成功；无效计划、日期格式、证据、参数、数据库、权限、场景错误仍抛出。业务完成进度独立于能否评价时效。 |
| 依赖预计和统计 | 受损节点时效/下游预计 unknown；独立可信节点照常评价。受损聚合仍保留可单独证明的有效批次临期/逾期，并显示原因；fact_time 覆盖统计包含已完成坏单，不把它当正常零值或丢单。 | 不改已冻结计划/参数/revision；不重新计算或回写旧 TEST 的实绩。保留请求编号和其它有效局部风险。 |
| SLA → OrderClosureService → receivingForecast | 本单 ContextBusinessClock 使用调用者已有连接；收货、装箱、返工原生事实和授权仍来自原表/原事件。 | 不改收货/结案/工资状态机或业务发生记录。其它 evidence adapters 均复用传入 db，不另开连接。 |
| 读取的一致性保护 | Journey 与公开 SLA 读取在快照内读取同场景/版本；拥有事务的入口先 COMMIT/release，再用空闲池连接复核真实最新场景/版本/now。 | 不用同一可重复读快照冒充新版本复核；不持满池连接再借第二个连接。调用者持有的 strict 事务仍沿原事务/时钟范围。 |
| 原生板房历史 | 在授权 detail 上按本轮唯一终结 action/event、跨轮明确 previousRoundId 或原业务终结依据定位；审计 created_at 保留真实值，SQL 读取微秒精度辅助键。 | UUID 只作事件身份，不当时序；同微秒无法证明顺序、终结缺失、历史场景/版本不一致均 unknown，不借当前 now 反推。未结束的当前节点保持当前页。 |
| 历史资料/附件/工资 | 用终结前的原材料事件、原附件 ID 与已经授权的文件交集回放；附件 bound_at、工资资格登记仍是真审计时域，保留微秒。执行段/转交/完工/费用确认按原事件证据收窄，历史只读。 | 不返回 raw audit payload，不用当前制作依据补历史；人员/价格 mask 不扩大。misc 工资按原已录工时及完工/停止事实和工资审计保留，不能用后录工时或后登记资格回灌。 |
| 原生节点停留、数字任务停留 | 绑定 source 的原生节点读取本单业务观察；缺失或倒序返回明确未知。工作台只按 task.asOf/实际完成端点计算；原任务负时长和未来完成为 unknown。 | 不 clamp 成 0，不造进入时间；普通未绑定单继续真实时间。 |
| 船样等 date_target 摘要/历史 | 读取原 deadline revisions.deadline_kind 及 dueAt；原任务头和历史均显示北京时间日期截止，即使 slaHours=null。日期型仍是排他日终边界。 | enteredAt 保持 null；无限期/duration 不冒充日期型；主办人与 timeQuality 分开显示，不更改原人员或时间质量事实。 |
| HTTP 未分类错误 | DigitalRequestError 在保留状态/错误码/未知提交语义的同时展示安全格式的 x-request-id。 | 不吞服务器失败或当作局部可恢复事实；其它客户端协议不改。 |

全范围候选索引 acceptance-time-sites-20261027.json 随实际源码更新。该索引的 pending 仍表示未完成逐项语义验明，不能把 grep/索引匹配宣称全轮完成；其余 PR 的入口/写入/扫描/日期控件责任继续见 PR1 时间契约，不提前施工 PR5/6。所有旧 migration/checksum、审计默认、认证/session/TTL/网络超时保持原样。

## 本地回归与自查证据

- 明确 RED：逐任务 asOf 丢失；冻结时钟历史错误过滤/当前完成页冒充历史；SLA 时序异常拖垮读取；船样原头显示无时限。均先复现后修复。
- 全部单元测试：483 文件、2557 项通过。随后工资审计微秒收窄的定向复验：4 文件、70 项通过；不以较早全量结果冒充后改源码已重跑全量。
- PostgreSQL 实际版本 13.23 / 16.15：新增原生读取矩阵各 8 项通过（独占完整 schema、原 UAT、全部 SQL guard）：过去/当前/未来/普通；历史字段和原附件；混场景列表/看板；旧坏完成与好单/搜索/覆盖筛选/原数据不变；整单公开读取与 strict 命令拒绝；船样摘要/历史 date_target；连接池 10、无 ALS；提交后时钟前进触发 409；跨场景拒绝。
- 原 Journey 26 项已分批覆盖：首轮 24 项通过；两项分页/板房摘要断言在收回额外整单读取后各于 PG13/16 定向复验通过。最终 Head 的 CI 会单独取证，不把本地分批当作同一轮全绿。
- 原历史单元覆盖跨轮返工/交接/取消、缺失终结、执行段转交金额、worker/finance mask、后录工时；新增冻结业务秒、多微秒事件、完全同审计时刻歧义、场景/版本矛盾、完成当前轮历史与普通当前活页。严格计算与读取隔离分别验证；同批坏+好窗口保留可证明风险。
- 本地合成浏览器：船样日期截止、缺目标日期、无时限、duration及原修订表，与人员/时间依据分开显示；同板过去/当前/未来任务均按各自时钟停留 2 小时，缺时钟/倒序明确待核，已完成以真实业务终点停留 1 小时。测试使用实际 React 组件，不是现场 Acceptance 或视觉全验。
- 北京时间日终 -1/0/+1ms、缺 duration 起点、未知事实/无效计划/参数/证据/DB/权限/隔离错误的允许与拒绝均有定向断言。
- 无 schema/migration、线上写入或历史改写。Full Gate 与 GitHub Codex Review 均待稳定 Head；本地通过不等于部署或 Acceptance 业务复验通过。
