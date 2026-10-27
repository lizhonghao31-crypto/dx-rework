# PR4 集中收口：读取入口与消费者核对表

远端审核基准4063e9bf（Full40478944351成功）；Review6438574042/6438578955已完成，唯一P2 r4387186082。当前补修全部本地，尚未push。用户最新要求：旧绿Head先Review，Review与自查项一起修；父核本清单和集中结果后一次push/最终CI，不再手动Review。本表是确定范围的消费者核查，不把全仓候选索引或用例通过冒充全仓审完。

| 入口/消费者 | 分类与实际时间来源 | 状态/证据 |
| --- | --- | --- |
| evaluateSlaPlan：SlaOrderService公开read | 授权后原order ContextClock(existingclient)，只读枚举时序错误隔离；own read释放事务后核新版本 | 已修；native公开read/strict拒绝/满池与场景冲突；原事实不变 |
| evaluateSlaPlan：readJourneySupervision来源分支 | 原source已捕获BusinessTime，evidence不补当前事实；局部可证明批次风险保留 | 已修；分类坏节点+好节点/坏批+好批/未知异常抛出单元；native坏单+好单 |
| evaluateSlaPlan：SlaOrderApplication预览/应用 | 原readWithClient默认strict，假设参数变化只评价原facts，不向读取隔离mode降级 | 原正确并保留；同一native坏事实read可读、strict拒绝；原SLA应用套件最终复跑 |
| Journey read/list/search/export、selectJourneys/KPI | project逐原source/order观察；SQL列表/日志cutoff审计真实；已填display直接聚合，不给混场景列表套一钟 | 已修；native混4种时间/筛选/请求编号/角色/满池/COMMIT后advance；原26项回归 |
| journeyTaskSummaries → patternBusiness列表/风险/KPI | 将原revision deadline_kind/sla_basis.exclusive按该project原观察协议透传，和detail同边界；不重算deadline | 已修；精确dueAt -1/0/+1ms RED已证，native详情/列表/风险/KPI对照 |
| DevelopmentWorkspaceQuery.pattern → items/boardPreview/risks → stay | 每task保留journey.asOf；停留取自己asOf或自己completed实际端点；列表asOf不作替身 | 已修；native混钟、单元三个投影、原React浏览器3场景/缺钟/倒序/已完成 |
| TaskService.read → DigitalTask + UI四个digitalTaskTiming消费者 | 服务器原task归属时钟+deadlineMode；TaskPanel、bulk-pattern-card、production-command-center-view、digital-cockpit-model均经acceptanceTaskNow按task/source/order ID匹配 | DTO/负时长已修；四个实际调用者源码核对均无全局强套；nativeTask元数据和原单元/构建 |
| todoSlaTiming（digitalTaskTiming第5消费者） | 输入asOf由各已授权原单提供；unknown不能因warning存在冒充normal，显式unlimited不被缺字段冒充 | 已修；新的unknown回归及原SLA presentation矩阵 |
| todoSlaTiming调用：sourcingTodoPresentation | 原motherID ContextClock；List/search/get均数据库query释放后调用，不持事务再借池 | 原正确；三个实际调用者核对，不改提醒/去重；原Todo/SLA原生套件 |
| todoSlaTiming调用：NotificationService.todos | 每task原source/order ContextClock；不是列表墙钟 | 原正确；原notification/clock覆盖，未新增提醒规则 |
| todoSlaTiming调用：factoryProductionQcTodos/garmentQualityTodos | 唯一生产调用者NotificationService显式注入ContextClock(pool)，逐原order read；不使用helper默认假Pool | 原正确（实际调用图已核）；原工厂/QC/收货待办套件，场景最终组合再核扫描 |
| taskAnalysis唯一生产调用者：DigitalAnalysisQuery.snapshot | 授权完成后逐原source/order ContextClock(existingdb)，同一资源缓存一次；list/export/record都复用该snapshot；全局asOf仍是真报告时间 | 已修；本地原生RED已证；混过去/当前/未来/普通，非授权403/空范围不泄漏 |
| taskAnalysis：未结束blocked等待、精确周期/按期分母 | 未结束等待用row.businessTime.now；已结束只认本单可证终点。未来完成/倒序不计精确分母；场景业务时刻与真实登记不计算假登记延迟 | 已修；过去/当前/未来等待与分母/原审计不变单元；不是只改overdue |
| isAnalysisOverdue → workspaceAnalysisRows metric/overview snapshot/node KPI | 同一row.businessTime；duration保留原严格过截止，date_target用排他日终且不需enteredAt | 已修；native筛选/总数/KPI与日期边界±1ms；普通真实时钟保留 |
| DigitalAnalysisQuery.export及record快照 | 导出重用相同逐任务判定，新增业务观察字段；Workbook生成/操作审计真实，原创建日期/用户查询窗口/后续观察计划仍原口径 | 已修派生消费；native实际xlsx内容、真实导出audit；不改业务订单或记录来源权限 |
| DigitalAnalysisPage实际显示/日期控件 | 显示各场景业务观察；全局报告日期过滤默认仍真实日/用户显式范围，不拿任一场景替换；不造输入max限制 | 已修时刻说明；原React本地浏览器混3场景+普通只读，非现场验收 |
| date_target原任务摘要/历史 | 原deadline_kind和dueAt独立于slaHours；缺日期不叫无限；无duration起点，不混人员/时间依据 | 已修；native读/history元数据、日期末±1ms、React日期/缺目标/unlimited/duration/修订表 |
| pattern原生历史、附件、工资 | 唯一终结身份+真实微秒顺序；rework_requested仅previousRoundId；同刻歧义/跨场景版本/缺证据unknown；原DTO授权上界 | 已修ReviewP2；RED后单元通过、PG16连续两次原生返工通过；普通/冻结历史/价格与worker mask |
| 旧LegacyPatternWorkspace包装、rework-node-history、sourcing-contract-history-scope | Legacy包装无计时；返工选真实终结事件created_at::text再筛真实审计；合同scope不做时刻运算 | 原正确（源码核），没有按pattern bug批量替换其它域；原返工/合同套件保留 |
| 独立合同return/monitor/list/facts/todos/scan | PR3已用原case验证clock；48h/Sunday/首次不重启业务规则和PDF/上传真审计分开 | 已在PR3修并合并，当前未重改；最终六PR组合重跑相关矩阵 |
| factoryBatchTiming/SLA anchors、receivingForecast | 前者是原业务事实/contract-ready max，非现在时间默认；后者在OrderClosure.read用已有连接原order clock | PR1锚点原正确；PR4 closure连接已修并native满池SLA读取验证 |
| 后续PR5/PR6 | 导航/实体URL/责任文案；官方交付容量/真实系统审计。均不提前施工，不让后续范围承担已证读取遗漏 | 后续范围，未称完成 |
| 尚未执行 | 现场全链、真实浏览器/设备、最终六PR组合及新候选Acceptance更新；10并发通知扫描非本轮新逻辑测试 | 未验证，明确边界；不能以当前本地矩阵/旧绿Head代替。当前同范围已证阻断均集中修复，父仍需核定 |

防回归：time-site-inventory新增reader候选种类，显式记录上述helper调用/定义及对应源码行hash；新增/改动上述具名调用会让索引检查失败，要求语义核查刷新。别名、动态调用和函数体整体语义不属此正则候选保证；它仅是受控清单漂移检测，不是传入正确clock的运行时证明；实际归属/时间/权限以原生矩阵验证。未扩大忽略或降低CI。

## 集中本地验证结果（待父核定、尚未推送）

- 全量单元：483文件、2566项通过（pr4-consolidated-all-unit.log）。
- PG13.23 / PG16.15：各在同一轮通过38项（原Journey26＋扩展原生12，pr4-consolidated-pg13-final.log / pg16-final.log）；随后针对原生blocked→逐任务时钟→已知等待/KPI→实际xlsx→unblock终点补链，各1项通过（pr4-native-wait-pg13.log / pg16.log，另外12项为主动名称过滤，不能称未执行项通过）。没有把分批说成同一轮39项。
- actual React分析页混3场景＋普通只读浏览器通过；F8混钟与日期任务浏览器此前已通过。本次未改这两条原组件表现逻辑，不重复无关浏览器轮次。
- 类型检查、API/web构建、lint、额外新文件lint、时间索引410文件/1628候选、写入守卫及secret扫描通过；候选匹配不是语义审核结论。
- 明确RED：分析场景任务未截止被墙钟列为逾期、summary在duration恰好dueAt与详情不一致、连续返工历史终结匹配二义。修复和相应回归已集中完成，未清理历史、未修改旧migration/SQLguard/权限或CI阈值。
- 远端仍4063e9bf，旧Full40478944351和已完成Review只证明该审核基准。下一次推送必须等父对本清单/补丁/结果独立确认，再一次push并核新HeadCI；不另发Review、不抢合、不部署。
