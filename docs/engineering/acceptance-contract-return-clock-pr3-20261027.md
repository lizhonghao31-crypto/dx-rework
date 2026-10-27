# PR3：合同独立回签的原单业务时间

## 施工基线与授权

- repository：lizhonghao31-crypto/dx-rework；base release/digital-production-v1 @f373c7ce6842e882d82403ad8f2186cdf91540bd。
- tree：8938e1e571e88bdd5494c284d95d2a72a506f283；PR2 #865 完成当前Head Full40449423359及明确无发现Review后合并，才创建本分支。
- branch：fix/acceptance-contract-return-clock-pr3-20261027；gate FULL。只在本PR收口合入release后开始PR4。
- 当前用户规则：每轮Codex Review超过15分钟仍无结论可自动重触发；先核完成状态/已有请求，记录实际新请求时间，不改Head/重跑CI/关开PR来重触发。已有明确结论后不继续超时重发。
- 禁止 main 合并、部署/ECS/现场DB/账号写入、清理旧TEST、旧migration/checksum变更、改48h/Sunday规则、加入P09参数、混入PR4一般历史/坏单读取或PR5导航。

## 已核既有契约（实现前冻结）

| 入口/字段 | 已核语义与保持项 | 本PR接线 |
| --- | --- | --- |
| prepareForApproval → monitor eligibility | 最新09/24规则覆盖早期环境开关/日期排除；所有有真实批准的未删除订单具备回传资格。 | 不恢复旧开关、不改变批准/范围/角色；不新增审批门槛。 |
| 首次PDF ready → monitor generated/due | 0207起算；0210已允许PDF前回传；due仍须等于add_hours(real generated,48)。 | 保留原列和trigger。仅从263同case、is_first_for_case、同实际原PDF及monitor锚点的不可变ready事实投影业务起点及48h due。无可信事实不拿当前scene now回填。 |
| 新厂/仅价格批准 → return cycle | 0228按实际重签快照唯一；cycle.first_document_id及generated_at必须等于真实文档事实。 | 保留原cycle和相等约束；业务起点只取cycle.first_document_id对应263事实。信息修订/下载/重复生成不重启；新业务cycle才有独立窗口。 |
| 初次回签先于PDF | 原0210明确允许；原首次上传保留，生成后不得覆盖。 | 业务回传也允许先于业务ready；未ready时起点/due为空，不伪造时间；不能新增ready前置。重签原当前版本ready门槛仍保留。 |
| submit → submission/link/request/monitor/event/todo | submitted_at=clock_timestamp、文件ready/updated_at、operation created_at、历史显示为真实审计；原case锁、角色、文件归属、版本、累计2文件20MiB、同key与同文件重试不变。 | 一次取原case→母单已验证BusinessClock；向新追加事实记录该次有效回传的业务时间及原submission/event/场景版本，同事务失败全回滚。旧上传时刻不改成虚拟时间。 |
| get → contractReturnState | 原四态及截止相等时仍pending/on_time，逾期剔除上海周日。 | 当前场景asOf按原单；有效终点取第一条实际有效回传的匹配业务事实，补传/推进clock不清零。PDF实际生成和版本submittedAt仍真实。 |
| sourcing readCase/list/filter/totals | 当前两处查询及全部逾期筛选用CURRENT_TIMESTAMP；列表可能混多个scene。 | 统一扩展facts，逐单business asOf，同一SQL快照的筛选与总量一致；全局列表不套单场景clock。缺证据显示时效未知，不能归入已证的四态指标。 |
| 历史与旧scene | 普通旧数据走原audit读口径；三单历史cycle及其余未纳入旧记录的规则不改，不执行历史补录工具。 | 只有同实际PDF/有效submission/原场景/可信clock版本证据才可明确只读投影，否则unknown。历史节点尚无可靠终结cutoff的场景合同不套当前资料/当前now；一般历史同秒/附件序列继续PR4。 |
| transfer/price contract todos | 原policy due_at=NULL、max_reminders=0，不制造24h或新48h todo deadline。 | 有效文件是否已回传与业务时效质量分开；旧时间缺证据不重开已完成待办。网络/认证/outbox重试继续真实时间。 |

## 最小兼容schema与读写边界

1. 追加0265，保留0207/0210/0228及263的原SQL和checksum。起点复用263的不可变原文档ready事实，不另起重复时钟，不回填旧monitor/cycle。
2. 新增逐submission业务回传事实，绑定原case、原submission、原操作事件及业务时间。SQL核原native case→母单不可变关联、场景/版本/now、当前事务事件/附件/提交人及实际Acceptance/Root/corp/UAT。表内事实不可覆写/删除。
3. 原sourcing_contract_return_facts返回契约保留。新增统一有效facts读取：普通单完整保留旧audit路径；场景由原ready事实及新回传事实投影，旧上传仅在原事件与同submission/附件/scene/clock版本严格匹配时只读投影。缺/歧义证据unknown，不GET修库。
4. SQL逐单场景读取必须配合API的已验证ContextBusinessClock/原scope校验；无reader不得把绑定场景降级墙钟。已有事务复用本事务连接；全局列表保持逐单观察和同查询筛选快照。
5. 新时间质量/原因只解释时效能否评估，不新增业务状态、不改变文件可见/回传资格或既有角色权限。PDF generatedAt及版本submittedAt审计字段不变；时效标签明确是起算/有效回传时间。

## 冻结回归矩阵

- 先RED：原生过去/未来scene的首次monitor起点、due和回传终点与原业务clock不一致；确认263原ready事实及真实PDF审计同时存在。
- PG13.23/16：过去/当前/未来/普通；原HTTP读取/上传、无ALS后台ready、跨scene/混普通拒绝、列表多scene不串钟、筛选与总量同口径。
- 上海周五10:00→周一10:00；周日生成→周一零点起算；恰落周日零点顺延周一；日终±1ms、due±1ms；逾期小时排除周日，首次有效终点冻结。
- 首次PDF前回传、失败后ready、信息更新/下载/重复生成不重启；厂变化及仅价格重签独立cycle，旧版本/旧附件不完成新cycle，原首次与旧cycle保留。
- 同key/不同key同文件、并发、过期/错版本/角色拒绝、累计文件数量/大小/归属；事件/新事实/文件绑定/monitor/todo失败整事务回滚与原key恢复。
- 旧场景缺原ready或有效终点证据unknown且文件仍可查看；能证明的旧业务版本明确只读投影；普通旧历史/三单例外规则不变，无历史写入。
- 全类型/构建/现有必需Full Gate；每个新Head核对应CI；六PR最终组合仍须复跑全部受影响矩阵，不能将本PR绿灯当现场验收。

## 已实现入口与时间分类

| 路径 | 原归属、时间来源及已处理边界 | 分类 |
| --- | --- | --- |
| 原 `/sourcing/cases/:id/contract-return` GET/POST | 原hook从case找到母单及场景；服务同事务复用连接的ContextBusinessClock，普通单保留真实时域。HTTP原角色/附件/当前文档/累计额度守卫不变。 | 业务读写，PR3 |
| 首次ready与无ALS后台生成/恢复 | PR1的263原文档事实已记录已验证clock；本PR按原first_for_case/实际document与monitor一致证据读取。PDF generated_at/prepared_at、附件ready_at继续真实审计。 | 业务依赖＋真实审计，PR1/3 |
| 新厂/仅价格重签及信息修订 | 0228原事件和快照决定cycle身份，原first_document_id决定263业务起点；原PDF约束完整保留。信息修订同cycle不重启。 | 业务锚点，PR3 |
| 上传submission、附件link/request、monitor、event、todo | 原submitted_at/created_at/updated_at及monitor原列仍审计；新事实显式写业务时刻、原scope/revision/event。失败整事务回滚。 | 并行业务证据＋真实审计，PR3 |
| 单单与全局列表/四态筛选/分页总量 | 单SQL快照逐单business_as_of，不给多场景列表套单个now；查询前验证reader，逐项核原scope。普通单响应不新增会变化的asOf字段，保留既有快照契约。 | 业务观测，PR3 |
| 首次/转厂/价格回签待办与通知 | policy仍due_at=NULL/max_reminders=0；有效文件事实与时效质量独立。delivery-worker这里只读原款号，原推送/重试/网络超时继续真实时间，无新的48h扫描参数。 | 文件事实＋审计/安全；PR3核查 |
| 原历史节点、三单Root补录入口 | 原历史节点继续隐藏当前回签时效；三单固定历史基准及其真实PDF口径未改，不运行补录。一般同秒事件/附件cutoff仍归PR4。 | 原历史规则；PR4一般历史待办 |
| 合同正文/手工signedOn | 用户约定日期只校验既有格式，不作为48h起点/终点；正文默认日期与其它日期控件保留在全范围清单，不以本PR绿灯宣称全部日期入口完成。 | 日期型边界，PR4清单复核 |
| 身份/会话/幂等TTL、PDF领用恢复租约、outbox | 继续Date.now/CURRENT_TIMESTAMP真实时钟；不作全局替换。 | 安全/审计，不适用虚拟时间 |

追加0265只建新事实和新的扩展读取函数，原9列facts函数保留。两个逐case函数明确ROWS 1（均严格返回唯一case），避免默认1000行估计放大原读取连接计划。SQL只将列举的坏时间JSON转换错误归为无证据；数据库/权限/隔离及其它未知异常继续抛出。

## 回归记录

- 原始RED：PG16原生过去/未来起点及回传终点3项均失败；263业务ready与真实PDF审计同时存在，已固定复现。
- 最终PG16/PG13.23：各4文件169项全部通过（原外发140＋新增原生20、cycle/SQL/满池4、原HTTP5）。过去/当前/未来/普通、多场景、Sunday与日终/due±1ms、先回传后ready、首次终点冻结、同/异key与并发、price/factory重签、信息修订不重启、失败整事务回滚、未知/唯一旧证据、无reader/错scene及SQL守卫均有实际断言。
- 本地合成浏览器34项通过，含390/1440宽“时效未知”原因、旧文件、只读零POST；原角色与转厂/价格/合同版本显示回归保留。
- 发现并修复：PL/pgSQL旧事件分支变量/列名歧义；普通单新增墙钟asOf破坏原两项只读快照，已恢复普通单原响应，原140项完整重跑通过。两处普通单query mock补充原scope读取，未降低业务断言。
- 早先使用旧SQL定义的PG13运行取消，不计通过；上面的PG13结果为当前完整SQL/TS的独立重跑。旧migration及checksum完全未改。
- 全部单测最终聚合482文件/2527项通过；最终lint/typecheck、API/web构建、时间写入口检查/候选清单/secret scan通过。两版PG另各13项migration兼容与低权限维护回归通过；唯一旧证据投影追加歧义分支后，两版各1项定向复验通过（其余19项为本次过滤，非跳过整轮）。
- 精确Head source compatibility、CI和Review状态记录于PR证据，须全部满足才合并。CI之后若有实际代码修复必须核新Head，不以本地或旧Head绿灯替代。

PR4–PR6未开始，Acceptance未更新。本地隔离fixture/合成浏览器通过不代表现场业务复验通过。
