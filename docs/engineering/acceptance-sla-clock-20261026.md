# Acceptance SLA 测试时钟施工记录

## 本轮基线与边界

- repository: lizhonghao31-crypto/dx-rework
- base: release/digital-production-v1 @ b79d395ff9b2d04babb6ab0db5c32a024bd681b5
- main: 67841e105fe7090e219477171d3cf79565719241
- branch: feat/acceptance-sla-clock-20261026
- gate: FULL；完成本地相关验证后一次稳定推送，至多一次必要 Codex Review；本轮不合并。
- 保留 WIP0ee7bd4；不施工 PR09/10，不改旧迁移、CI规则、生产配置，不部署或连接线上数据库。

## 完成标准

1. 复用 BusinessClock。仅已通过原 Acceptance 启动数据库/uat-root/外部副作用校验的运行时启用；生产请求不能打开。沿原控制会话及真实 UAT 业务角色，不新增长期凭证或角色特权。
2. 新场景通过原业务服务新建测试来源；同事务登记不可重绑的场景关联。无绑定任意既有订单入口。母单、PO、任务、复版及原生子单沿真实关联解析，不靠款号前缀猜归属。跨场景或测试/非测试混合请求拒绝。
3. 持久化场景时间、版本和命令记录；只向前。重复命令幂等、并发冲突可见、重启重读保留。重测新建场景，仅复制业务输入，不复制完成事实、物流、实际时间或原单数量。
4. 业务校验/事件/计划/实际/预测/待办共用已验证场景时间；日志登记时间、认证和基础设施计时保留真实时间。不 patch Date.now、不改 OS 或数据库全局时间。未知事实继续未知，推进时间不完成业务。
5. 复用原提醒计算与去重，显式扫描返回完成/失败；场景记录只进入测试接收端，真实员工和外部钉钉/邮件不调用。配置选择与推进时间分开；只引用既有已发布标准，不允许在时钟工具发布全局参数。
6. 预览绑定场景、标准、计划和业务事实版本；配置/业务/时间变化使旧预览失效。支持30分钟/2小时/1天、指定未来时间、临期/到期边界前后1ms；日期型日终和精确时刻等号语义分别保留。
7. 工具仅在 Acceptance 测试详情折叠区显示；沿用现有组件、字号和间距，清楚显示测试时间。实际浏览器覆盖PC/窄屏、长值、刷新、冲突/失败和权限视角。
8. 集中验证201h、并行、70%、日终、真实窗口不重置、来源转母单/复版/返工、部分收货/更正、跨场景、生产拒绝及通知隔离，再开独立draft PR。CI/Review不替代现场Acceptance验收。

## 改动落点

- 附加0262迁移、manifest及维护权限清单：场景时钟/关联/推进历史/测试接收证据；原迁移checksum保留。
- acceptance-clock模块：原控制认证适配、场景持久化与锁、资源归属解析、预览及原提醒扫描。
- 原P1–8服务：只接业务时间与测试范围，原质量、数量、权限、实际收件及原生业务顺序保持；不复制业务事实或另造计划引擎。
- 原Lab及业务详情：新建/复制测试场景、折叠时间控制；不重画座舱，不添加生产办理入口。

## 旧todo夹具三项（仅记录，不在本PR修复）

原基线76ef086784a0bde5920fab695784c96e63a02609和当时候选均真实复现1pass/3fail；夹具只安装0001–0028，现代未改实现需要后续schema：

- `deduplicates queued delivery, records provider results, and never revives a completed todo`：TodoDeliveryWorker读取的current_sourcing_case_lines缺失（0193后视图依赖）。
- `blocks an ineligible recipient, exposes only a routing exception, and requires an audited transfer`：AccessMasterDataService需要app_users.manual_access_disabled（0089）而旧夹具缺列。
- `re-routes a stale routing manager while retaining an auditable exception history`：同一manual_access_disabled依赖缺失。

证据保存在原隔离环境route-b-baseline-proof.md、baseline76-todo-foundation.json、snapshot-connection-regressions.json。该显式PG文件不在当时映射清单，普通无DB测试跳过；三项未算通过，不降低断言或扩大到整套待办治理。


## 本地完成与核验证据（2026-10-26，未替代最终 Head Gate）

- 实现：场景单调时间/并发版本/幂等与历史、新建UAT来源及母单绑定、原子原生子单关联、原配置版本引用、原流程的业务发生时间适配；认证、重试期限、审计登记时间仍用真实时间。
- 原时限精度随测试任务读取，精确时刻等号与日期次日零点排他边界在页面/原统计/原提醒保持一致；未修改旧任务默认规则。只注入现有统计的逐单时钟，不实现PR10新统计口径或新模块。
- 扫描复用原通知与TodoTiming，按场景在分页前过滤；测试外送直接写测试接收证据，不入真实外送队列。中断/失败留痕；原有单批50条限制保留，结果包含批次计数和可能仍有后续标识。旧命令迟到重试只返回原效果，不回放旧时间或重复推进。
- 车板原生业务起止使用场景时间；附件权限仍取原操作事件真实登记截止，不用未来业务结束时间扩大权限。Root允许与普通执行人拒绝晚绑定附件均做实测。
- `acceptance-sla-clock-postgres.test.ts`：隔离PG16.2，14/14（启用本地浏览器用例时）；CI没有本地浏览器环境时该1项显式skip，其余13项必须执行。包括四种原生工艺/洗水路线在+201h场景、原Control+Session HTTP、精确临期/到期、未知保留、原生事实变更使预览过期、源转母单冻结、独立复版、复制输入、12并发排队、失败/中断扫描、旧命令迟到重试、拒绝跨场景/旧业务/真实身份。
- 原业务重点回归：完整真实schema下，`full-business-chain-postgres`所选3项通过/55项未选；`sourcing-pr03-postgres`所选16项通过/118项未选。仅为有界回归，未称整个业务链已跑完。
- 相关单元：一次9文件80项、一次5文件50项、最终边界/UI规范6文件49项通过，范围有重叠，不累加为独立总数。
- 普通无DB完整测试本地运行一次：2810pass、2fail、734skip。两失败为本次面板未复用既有应用弹窗和客户端请求ID工具；已改用confirmInApp/createClientRequestId，相关规范测试及边界组定向通过。没有重跑整套冒称最终Head全绿，最终CI必须重新完整验证。
- 浏览器：真实应用页+原UAT认证+隔离真实HTTP/PG，1440×1000与390×844，推进后刷新持久化通过；真实组件另外覆盖折叠、未保存输入保留、应用内取消刷新、长值、409预览失效、未启用隐藏。截图在本地clock-ui证据目录，组件mock测试不当成完整业务验收。
- API/Web类型检查、改动文件ESLint、Vite构建、迁移静态检查及工作树secret scan通过；Vite保留原大chunk提示，不额外拆包。新0262 checksum与manifest/维护清单一致，旧migration原样。

### 额外发现的旧精简夹具限制

`development-sla-enrollment-postgres.test.ts` 的 `converts a source without resetting its frozen standard or copying original actual evidence` 在本候选和原基线d783945a（tree与release b79d395f一致）均失败：夹具只装到0255，缺0230的bulk_ship_sample策略，转母单后无法创建该任务。其余所选三套SLA/预算PG组加该文件共32pass/1fail。未修改该旧夹具、未放宽生产守卫；本轮全schema源转母单与原生链通过。不把这项及前述旧todo三项计入通过。CI映射不含该旧文件，不以“未映射”证明其已修复。

### CI与交付边界

独立PR以release/digital-production-v1为base；现行分类器要求FULL：6个映射PG文件、完整业务链、PG13 Journey、Root审计及迁移/升级/备份恢复/打包等适用门禁。30分钟上限保持；此前完整链约25分钟仅为历史参考，不承诺本轮时长。只提交一个稳定Head，不以改描述触发重跑，不重复Review。

Full workflow仅增加一个既有低权限CI角色拥有的隔离Acceptance名称数据库及安全marker/环境变量，供本测试走原Acceptance数据库名称/uat-root防护；不放宽原生产防护、不改触发/风险分类/检查/权限/超时。

本轮完成后仍不合并、不部署；首次现场Acceptance主链验收待用户部署及主聊天核验。PR09在途应用WIP、PR10、原未授权重构均未混入。重启后场景时间保留，但原短期控制会话按既有规则重新登录。复制场景仅复用开发规格，附件与客户订单数量不复制，需按原入口准备测试资料。

## PR858 Review 闭环（2026-10-26）

- `95b15b664583b4ae0e08c5cb0bca456d4bfa6752` 的 Full Gate `40270157365` 成功；普通测试2813pass/734skip，时钟PG13pass/1浏览器skip，完整业务链387pass。CI显式skip仍不算浏览器或旧精简夹具通过。
- 首次Review从05:06起长期running，官方CLI的只读任务列表返回401，无法取得后台活动/取消证据；未擅自重发。用户05:34明确授权重开一次，评论6409029049；摘要05:35:43开始新轮，05:39:35完成，receipt5647824548，审查SHA仍为95b15b6。旧轮最终状态不可见，不宣称已取消。
- P2 `r4374261812`：原工厂物流和收齐预测读取遗漏时间参数，落回真实时刻。两服务改取原 `ContextBusinessClock` 的本单已验证时间，再传给原预测函数；无场景的订单仍走真实时间。原生发货回归覆盖预计范围结束前1ms、等号、后1ms，过期预计不再补足未收净量，时间推进不产生实收。
- P2 `r4374261818`：来源创建和文档保存各自提交，原来以来源存在即判复制完成。改为在同一场景锁下复用已建来源，缺文档才继续原生保存；已有文档不重抄、不覆盖后续业务编辑。新增隔离PG反例覆盖保存前失败、提交成功但响应丢失、运行时重建、同key并发重试、单一来源/冻结记录、真正复制输入及不复制完成事实。
- 修后本地时钟PG14pass/1浏览器skip；原工厂/回货重点2pass/132未选；相关3文件35项单元、API类型检查、全部5个改动TS文件ESLint、diff检查和工作树秘密扫描通过。首版新只读预测fixture遗漏允许QC身份，被原权限拒绝，已限定为该fixture的Root/QC两身份重验通过，生产权限未改。修复未改UI及迁移，沿用同Head前已记录的浏览器证据；最终新Head Gate另核，不以95b15b6绿灯替代。P2修后不再次请求Review，也不声称已独立复审。
