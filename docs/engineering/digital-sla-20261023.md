# 数字生产与 SLA 本轮施工记录

## 一次性基线

- repository: lizhonghao31-crypto/dx-rework
- execution: 全程接手；仅本轮集成分支，禁止合入 main/release 或线上操作
- main: ecaf69992c03b826837a61cf2053d0ee6d1fe4c9
- base: release/digital-production-v1 @ cab8412cbd4d0141044f05cd71f2102e874b518f
- integration: integration/digital-sla-20261023
- PR01: feature/sla-01-foundation；FULL（新增 schema、不可变版本与核心契约）
- 2026-10-23 检查：远端两分支与以上一致，开放 PR 查询为空，原 work 工作树干净。
- 使用最终本地修订四份文档；不使用 Library 旧船样规则。5组10个业务PR保持，新增一个已批准的隔离验收时钟工具PR，共11个PR。
- PR01 allowed: contracts/domain 的 SLA 契约与验证、production-platform 持久化、新增迁移及权限清单、定向测试、本施工记录。
- forbidden: 旧迁移、线上/Acceptance 数据、部署工具、CI门禁、业务外扩、全局UI重画。

## 已确认规则优先于旧稿

船样在大货生产前原区域记录发出状态、实际时间、操作人、快递单号（寄出必填）。仅记录与既定时效提醒，不增审批，不拦生产/回仓/QC/装箱/出货，不在其他动作提交时校验寄样。

出货直接复用有效装箱数量及原事实，不增按钮、登记和岗位。返工48小时从派工确认进入执行至该轮实际返工作业有效完成；区分整查，不等核量财务、不用总completed替代、不增复检。

裁床不填收布、不确认、不签收，也不默认增仓库填报；无可靠C仅限制实际评价精度，不伪造、不新增阻断。相关审批老板/root不漏，保留原质量数量和授权范围。

UI为交付核心：沿既有组件/token/局部布局；首屏关键日期、状态及操作，其余详情折叠；无文案墙、重复入口、强制等高。涉及UI的PR需本地实际浏览器证据，不能以CI代替。

## main 修复保留

不全量合并分叉。PR01新增独立契约及表，不替换原权限、数量、合同、返工或部署代码。main独有提交涉及合同价格/回传、仓管权限、返工handler等；不能以提交未祖先判断功能缺失，release已有0251桥接及主线迁移原校验和。后续触及对应模块逐项核等价保留。

## 当前交付约束

现有Gate白名单支持main、release/digital-production-v1、feat/digital-production-a4与历史unified-p*，未包含本轮integration分支。不擅改门禁或借历史授权扩大命名空间。父已明确允许以release为草稿PR审查目标，不合入该分支；本地保留依赖栈，后续候选固定Head，说明本次增量提交范围，避免反复rebase。只集成本轮专用分支，无部署授权。

PR01已推送57d7cf6a01b10d1ddb8d7ca82e648e8c7fb3850f，草稿PR #851。创建曾被自动审核拒绝，取得用户针对仓库/目标的明确授权后成功；无绕过。Full Gate运行39962568705，Quick Gate跳过。此处不把运行中写成通过；最终结果以该Head的GitHub证据为准。

## PR01 完成标准

完整参数目录与单位/时间类型；冻结规则版本和逐单解析快照；合法订单特例＞已有客户值＞全局默认；严拒未知键、错误类型、负数、非法比例和内含超窗。附加schema不激活新模型、不重评存量。并发版本/幂等及不可变历史须定向验证，迁移及权限清单同步。PR02接计算；PR09接授权发布与面板；无公开未授权写入入口。

### PR01 本地进度

已补完整参数目录、精度与来源契约、优先级解析、不可变配置与订单快照、0252附加迁移及checksum权限清单。无新业务路由或UI，无历史回填。新schema尚未启用新模型，旧程序不需读取这些表。

本地使用Node22.22.2、隔离安装依赖；测试PostgreSQL18运行于127.0.0.1:55432，临时数据仅在/tmp，合成订单，无生产连接。13个契约用例及3个PostgreSQL集成用例通过（并发只一方发布、原始快照不漂移、历史不可改、幂等冲突、事务回滚）。包构建、API类型检查、定向eslint和迁移静态检查通过。尚无GitHub Gate/Review证据。

## PR02 当前实现及后续接入

feature/sla-02-planning基于PR01。已补统一BusinessClock接口、七阶段结构计划、正倒排/并行/内含窗口、日期型和时分边界、真实窗口不重置、过期预计失效、业务进度等权、P0与正式版本及事实历史。创建订单在原事务内保存首版，来源不明不补时间；读取沿原订单权限。0253仅附加表，不回填历史。

新单按确认事件计制单72小时；开发历史只有发布日期不足以证明当时标准，不拿今天标准倒罚历史任务。既有任务、source开发首版、业务事件适配按PR03—08各闭环接入；目前仅新建确认事实和只读计划API已连接，不宣称全部实际事件已覆盖。没有真实C时不新增动作或阻断。

正式PO交期变更已接原审批事务，按对应PO保存Pk和日期来源，保留P0；重试不追加重复版本。沿原业务审批权限，不通过此钩子扩权。完成事实由服务捕获评价截止点，后改日期或工时不洗历史。正常延误读取不写计划版本。旧任务展示和待办仍待对应业务接入及PR09—10统一，不把基础API当完整页面验收。

本地12个计算反例、3个计划历史PostgreSQL用例、36个订单/权限/交期集成用例（共51）通过。验证含首次计划失败整笔回滚、重复创建只有一个P0、原订单权限拒绝其他设计师、正式交期按PO变更且不回填历史、并发冲突、重试、冻结完成评价、时钟倒退拒绝和真实审计时间独立。API类型检查、定向eslint、domain构建、迁移静态检查通过。无UI代码改动，无浏览器/线上验收结论。测试PostgreSQL仍为本地隔离fixture，不能代替部署账号权限门禁。

事实时间与审计记录时间独立；普通迟延只改变读取时F，不写P0。正式版本及事实纠正追加，旧版本可按当时事实及业务时点复算，禁止改派/退回抹开始时间。客户/订单覆盖必须由服务从合法来源解析，不能接收客户端自报来源；设置写入口在PR09以三角色及订单范围核验。当前只有原新建业务写入和受原权限约束的计划读取，没有通用计划编辑/事件填报接口。

## 隔离验收时钟（新增授权）

- PR02提供Clock契约；生产用SystemBusinessClock，不patch Date.now、不改OS/数据库时间。真实审计、认证、token及基础设施超时仍用真实时间。
- 独立工具PR依赖PR02及PR03—08事实接入，在首次Acceptance主链验收前交付；不因编号11等到全部验收后。业务5组框架不变。
- 仅受支持Acceptance控制可创建隔离场景并绑定测试母单/PO/任务/子单，生产后端拒绝请求；原岗位权限不因测试切换放宽。不得绑定真实订单。
- 持久化场景时间和版本，只能向前；30min/2h/1d、指定未来时刻、70%/到期前后最小精度。重测复制业务输入建新场景，不复制旧完成事实；复制命令幂等。
- 统一页面/后端/预计/提醒时钟，扫描完成或失败明确返回。跨阈值提醒去重，外发通知入测试接收记录，不发真实员工；隔离统计、工资、合同及配置标准。推进时间不完成业务前置。
- 计划、参数、事实和场景时钟版本均进入预览依据；任一变化使旧预览失效。场景重启恢复原时钟，失败扫描可重试且不重复通知。
- 验收包括原201h、并行、70%、日终/精确等号、真实C fixture、不重置、复版/返工、部分收货/纠正、旧逾期、并发幂等及生产拒绝。fixture明确标测试证据，不能变成线上收布填报。
- 本PR仅接口和规划依赖已实现，Acceptance控制、持久化时钟和界面尚未实现/未验收。

## PR02 父审集中修正

承诺日期只作计划/评价目标。没有可靠完成预计时，工厂节点的F保持未知；前置未知、晚于交期或与所报预计冲突时保留具体原因，实际完工仍优先。内含交接/回收的F从父节点实际或滚动窗口推导，不再复用P0开始时刻；既有P0、标准窗口及真实事件不变。

16项计算反例、3项计划历史PostgreSQL用例、36项订单/权限/交期集成用例共55项通过；API类型检查、contracts/domain/config编译、定向lint及diff检查通过。使用重建的本地隔离fixture。两项修正集中形成一个Head；旧604e5eed的Full Gate成功不作为新Head门禁证据。PR01正式Review已请求一次并运行中，不重复请求。

## PR02 正式 Review P2 修复

正式 Review 指出：remaining 分支仅对 order_date 核前置，duration/estimate 等可绕过上游未知或冲突。现统一对所有尚未实际开工的节点核对真实依赖/开始锚点；内含项沿父有效窗口，offset 的提醒目标不当成最早可做时间。实际开工或完成仍优先，P0/Pk不变，不新增业务拦截。

23项计算用例及3项计划历史PostgreSQL用例通过。新增参数化覆盖duration、estimate、order_date、unlimited、offset、included的前置未知、晚于预计、可靠预计、实际开工/完成优先及下游未知传播；另覆盖开始锚点未知与船样可早于提醒目标完成。domain编译、定向eslint通过。此次仅集中修复并推一个Head，不修改PR文案，不请求第二次Review；新Head以随后正常Full Gate为准。

## 2026-10-23 施工检查点

PR01 #851 / 57d7cf6a01b10d1ddb8d7ca82e648e8c7fb3850f：Full Gate 39962568705成功，Quick Gate跳过；未合并。正式GitHub `@codex review`已在新授权下成功发送一次（评论6366851045），Review运行中；不重复请求。

PR02 #852：604e5eed的Full Gate 39965719804成功；父审两项F修正集中提交41e50d5155bdcb96220c08ad02de0f9c1e05651c并已推送，等待该新Head Gate。未请求Review，未合并。

当前本地分支feature/sla-03-development，基于PR02。0254及development-sla-enrollment.ts仅为未接入的开发规则/路线快照草稿，尚未补迁移manifest、调用点或业务测试，不可提交或部署。API类型检查仅证明当前草稿可编译，不代表PR03实现或验收完成。后续仍须开发主链、外部纸样、独立复版分别闭环并做真实浏览器检查；没有创建任何业务UI截图或宣称UI通过。

原执行环境已恢复，PR03工作树保留。原/tmp测试工具未随恢复保留，已重建Node22与127.0.0.1:55432隔离合成数据PostgreSQL；无真实库操作。PR03基线已快进至PR02修复Head，未推送PR03。

## 本地复用修订：兼容边界定向验证

本节为后续本地修订状态，前述各 Head/运行记录仅为历史证据。当前未提交、未推送、未运行 CI 或 Review。原 PR03 的 51 文件成果已备份保留。

标准时长唯一写入原 deadline policies；发布层保存固定版本引用及原表不能表达的类型参数。values_json 只作不可变的旧读端兼容快照，不提供第二个编辑入口。旧发布行 policy_refs_json 为空时按该行原 JSON 读取，不用最新策略补历史。新的引用、派生 JSON、逐单快照由调用服务的同一事务提交；失败整体回滚。发布用的事务标记写完策略后即恢复，避免同事务后续旧写法借用标记。

回退策略：旧应用可读取兼容 JSON；已纳入统一发布的策略键，不允许旧应用继续直接发布版本（数据库触发器拒绝）。新应用原设置入口已转向统一服务，只影响新单，不直接重写在途任务；仍未实现的选定在途订单影响预览不能用旧入口替代。未纳入统一发布的其他旧策略不在本次拦截范围。此限制针对配置写入，不新增任何生产办理门禁。

本地隔离 PostgreSQL 18，127.0.0.1:55434，低权限合成测试身份；不是线上账号权限验收。本次配置集成 9 项通过（含持久化旧行、版本引用与派生值一致、另一连接不可见未提交发布、三项持久化共同回滚、三角色允许/其他拒绝、旧编辑入口新单范围）；开发定向 2 项通过（原事件记录外部纸样、旧设置入口不漂移待开工任务），其余 12 项未在本次重跑。配置用例 0.97 秒，开发定向 2.28 秒；只是本地耗时，不推算 CI 预算。API 类型检查、相关增量 ESLint、迁移静态清单检查通过。页面此次未重验，不将此前截图当新修改的最终验收。

发布依赖已核清并调整本地未提交编号：原兼容迁移只依赖 0252 配置表和 0220 策略表，不引用开发迁移对象。0252 已提交于 57d7cf6，0253 已提交于 604e5eed；需保留环境的应用状态未知，文件及校验和不改。两份新迁移仅有本地隔离测试证据、未提交未交付，因此兼容迁移安排为 0254_digital_sla_policy_references，开发迁移顺延为 0255_development_sla_enrollment，清单和测试引用同步。旧编号临时测试 schema 已由测试销毁，不修改任何已保留环境迁移记录。交付顺序建议为原01/02基础 → 独立基础复用修正（含新0254）→ PR03（含新0255）；不强塞回旧PR、不强推、不将全部工作合成巨型PR。外部提交仍未授权。

继续完成外部纸样原 task_events 读写适配：新增请求/收到事实只写原事件表，旧专用表仅兼容读取。再次请求后，页面显示最近一次及折叠历史，SLA不能继续取上一请求的已完成状态。本次相关数据库反例1项通过，其余13项跳过。两组实际组件浏览器检查分别6项通过：设置保存/版本冲突/只读，外部纸样请求/接收/只读，均含1440及390宽度。已实际打开设置窄屏和外部纸样PC/窄屏截图，关闭按钮不再断字、无横向溢出。浏览器使用合成HTTP，非已部署全应用验收；未据此宣称PR03整体完成。

## 实际事件单一来源及转母单连接

当前应用代码对 digital_sla_node_facts 只有兼容 SELECT，appendFact 写入方法及创建订单时三份复制写入已删除；历史0253表和不可变保护保留。创建事实来自原 audit_events 的 slaBusinessTime（真实审计记录时间不冒充业务时间）；无该字段的旧事件不补造时间，沿旧事实读取。开发事实来自原任务完成状态/质量、deadline revisions、退回事实及 time_corrected → corrects_event_id 更正链，外部纸样请求/收到新增事实写原 task_events。

修复原生开发事实被旧SLA副本覆盖的读取优先级：旧副本仅fallback，原生未知完成也必须覆盖过时副本。原创建事件只证明制单开始，不证明结束，因此制单旧有效完成及原评价截止仍保留，直到制单自身原生事实适配接管。没有把所有节点都宣称已完成适配；其余业务链仍按对应闭环实现。

开发转母单沿用 source.configuration_id / parameters_json，保留开发计划锚点及原节点，业务事实继续引用source/task，不复制成母单新完成事实。新增反例：冻结后改默认、转母单幂等、原起点不变；故意加入旧SLA完成副本，再通过原correctTime将原完成时间更正为未知并恢复，整单随原事实变化、P0不变、旧表无新增，原更正链两条记录可追溯；跨单权限和跨时钟场景拒绝。该闭环1项通过，原计划/历史兼容文件4项通过。一次错误测试过滤跳过依赖建数导致缺P0，已定位为测试执行选择问题，仅完整重跑该4项文件通过，未扩大套件或触发CI。

发布限制：原01/02未经本地复用修正不能单独标为可部署完成候选。独立修正是保留历史迁移和验证边界，不表示批准增加重复Full Gate。旧应用回退可读兼容快照，但其原配置写入口可能把数据库55000表现为500；不宣称完整可写/友好回退。回退期间该配置写入口不可用，恢复新应用后通过统一发布服务办理。生产业务办理不新增门禁。

## 业务完成与时效未知分离；PR03连接检查

父指出的语义已纠正：原任务没有被重新打开，但原SLA评价/进度把缺完成时间误当未完成。新增只读 businessCompleted 事实属性，来源为原有效业务状态；时间未知时 completed_unrated、无新增在途逾期、业务进度保留，实际完成日期及下游无依据日期保持未知。不改任务状态、不创建待办。有效退回/撤销仍不算完成。25项定向计算/转母单检查通过。

新增跨轮读取反例：前轮尾查退回、后轮待办、后轮有效通过，保留前轮失败事实并采用后轮业务完成；测试通过。该测试使用显式尾查边界数据库夹具，仅验证汇总，不称原生车板返工全链通过。夹具初次缺岗位和后次沿用旧occurrence均被原权限/唯一约束正确拒绝，修夹具后单项通过，未改保护。外样实际Fastify路由/Schema/服务/PostgreSQL串联测试通过，覆盖未登录401、设计师403、主管创建、原幂等及重复请求；认证身份为隔离夹具，不是完整认证系统/部署入口验收。

## PR04独立本地文件组：预算

预算相关文件修改前备份于 pr04-budget-before.tar.gz。复用原 budget_documents / versions / preparations / 附件：本单设计师及有效主跟单共享草稿；仅本单跟单或Root最终发布；发布即冻结，不能再另存新草稿改预算。原外发预算更正/合同定价流程未改。未新增表、审批层、交接工时、预算价格与合同价强等关系。发布原事务生成原外发准备待办，原幂等/版本冲突及不可变版本保护保留。

本地2项PostgreSQL预算事务测试＋6项原HTTP权限边界测试通过：共享读写、非本单拒绝、设计师不能最终发布、跟单最终冻结、重复命令仅一版、发布后设计师/跟单/Root不能覆盖、并发保存/发布只有一个成功。实际原预算组件1440/390浏览器各12项校验定位通过，已查看截图；合成HTTP，不宣称全应用验收。

三段2小时处于接入中，不能标已完成：新增 sourcing-todo-sla 从原外发transition事件和母单冻结snapshot计算截止，原TodoService仅在首次创建且去重后应用，既有todo不因重试重新起钟；不匹配/未纳入SLA的原流程保留。5项适配器单元测试通过，实际审批→待办数据库集成、原审批允许/拒绝及接收人回归仍须完成，尚不能据此提交。未改变通用todo policy数值或配置第二来源，提醒周期及Acceptance时钟仍待原对应闭环接入。

## 854 本轮复盘与推送前证据（2026-10-24，当前修订未推送）

以下记录本轮实际失败和漏检，不承诺零失败，不新增治理系统。

| 事实根因/漏检点 | 下次推送前的具体证据 |
|---|---|
| 已实现和已有测试不等于可交付。177文件WIP混有未完成09及共享依赖，不能直接作为完成PR。 | 保留WIP不可变引用；用检查点三方差异组装闭合候选，列base/head、依赖、排除项及迁移历史。05–06、07–08候选需同步854后续修复。 |
| 外部纸样、洗前检查已声明但漏入前端业务动作名单；只测先前开发节点不够。 | 每个DIGITAL_TASK_ROLES声明开发节点都映射业务办理，未知/其它节点拒绝；核对应表单及后端business_recorded条件，保留跨单权限。 |
| 30分钟校验脚本修改未实际lint，导致no-regex-spaces失败。之前“lint通过”仅覆盖测试文件，表述过宽。 | 对git diff中每个实际修改的脚本/TS文件执行仓库ESLint，保存真实命令和退出码；未覆盖的文件明确列出。 |
| Full30授权同步workflow和guard后漏旧unified预算测试；随后正则连续空格又触发lint。 | 同查workflow、guard、预算测试、政策文档；正例全Full30，31/300/0/缺失/重复/null/旧条件式均拒绝，Quick5不动。修改后同时跑预算和gate-maintenance集合。 |
| 固定裁板测试假设owner_group不存在，前序面料决定测试已创建有效老板，正确放行却被旧断言拒绝。 | 显式构造角色停用状态，finally恢复；验证停用拒绝、启用允许、固定裁板不可逐单改派、重试不重复及版本冲突。不得限制真实老板/root来迁就夹具。 |
| Journey订单服务用9月固定日历，开发发布用真实时间，形成业务时间倒拨。 | 日历边界和业务Clock分开注入；同关联链时钟一致。保留跨时钟域/倒拨拒绝、源单冻结继承和P0不重置测试。 |
| R2旧夹具只置ready条件却期待真实前置完成后的截止。 | 缺核配实际完成依据时保持未知；管理摘要/历史轮次读同一当前事实，正常已具事实的计时反例继续通过，不用ready时间伪造实际开始。 |
| 新辅料实收语义被误用于设计师退回补料重提，阻断进入文员复核。此项是实现兼容错误，不是仅旧断言。 | 仅缺项退回后的真实设计师到货允许重提复核；available/verified仍false，不放行车板或消除文员实收提醒；核主布及已通过缺辅料的原边界不变。 |
| 改派历史用例选了新规则下固定裁板节点，仍期待总委派。 | 用仍允许总委派的纸样验证名称/ID/历史投影；固定裁板拒绝由完整开发套件保留。区分历史单和新纳入路线，不删除历史保护。 |
| 身份/历史组旧断言禁止老板审批客户交期，和用户已确认规则冲突。 | 有效总监、有效老板各跑同一PO选择/数量稳定/幂等链；主跟单和伪造角色拒绝。请求权、自批限制及其它日期底层边界不能凭审批授权泛化。 |
| 只修首个串行失败就push，多次Full仍在后续相关组发现同根问题。 | 先在隔离库闭合Journey全23、身份/历史全组、开发16、预算/配置/计划，以及同源业务链/sourcing关键用例；保存失败原因和最终复验，不把旧Head或局部通过当新候选全绿。未父审前不push。 |
| Zod4.4.3安全公告是外部依赖变动；Chat npm DNS EAI_AGAIN是环境问题。动作漏项、lint漏文件、预算测试及fixture不同步是本轮工程遗漏。 | 依赖修复用指定Node/npm真实生成锁，核3项lock变化，audit保留低/中风险说明；DNS失败报告实际阻断。不得把确定测试/生产问题称flaky或环境问题。 |

当前本地修正：development-material-readiness只允许退回补料进入原复核，不改变实收/质量放行；Journey分离日历和系统业务Clock、缺真实R2起点保持未知、历史改派用纸样；客户交期测试分别覆盖合法总监/老板审批。首次集中组101 passed / 1 failed / 0 skipped，失败为旧老板断言，其它6文件通过；修正后独立完整身份组37 passed / 0 failed / 0 skipped。Journey23、开发16等已完成本地验证，另外sourcing为4 passed / 0 failed / 110 skipped，full-business-chain为4 passed / 0 failed / 54 skipped。实际本地隔离PostgreSQL为18.4，不是CI的PG13/16验证。4个代码/测试文件限定lint与API typecheck退出码0。完整CI、部署和认证浏览器验收不在此次本地结论内，不代表Full通过。父审核已允许仅提交并一次推送这5文件；随后停止，不等待CI，不再用Work跟进下一轮失败。

## 854 本 Chat 同源失败修复与最终本地证据（2026-10-24，待确认推送）

本节记录本 Chat 的新一轮修复。前节的 PG18.4、full-business-chain 4项和 sourcing 4项为上一轮历史证据，不是本候选的完整组结果；前节推送授权不用于本轮。当前按负责人要求先提交可审阅 diff 和验证结果，确认后才推送一次。

### 精确基线与范围

- repository：`lizhonghao31-crypto/dx-rework`；PR [#854](https://github.com/lizhonghao31-crypto/dx-rework/pull/854)。
- 远端分支：`deliver/sla-foundation-development-budget-20261024`；开工核对 Head 仍为 `2b028dd0895d9617d8c9e370caa08f6a5f66072d`，Base 为 `77a15f2f980d5d66c0312cc8d33b48544f289870`。
- 失败证据：[run 40068879908](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/40068879908)，job `120797809363`，已读取原始日志。
- 本地验证对象为上述 Head 加本轮未提交差异；未创建新候选 commit、未推送，不能把下面通过结果归给未修改的 `2b028dd`。
- 本轮只改两份测试 helper、两份集成测试及本记录。生产代码、迁移、锁文件、CI范围和时限不变；不合入 WIP，不修改后续05–06或07–08分支。

### 三条尾查失败的同一根因

在未修改的准确 Head 上，PG16.15 单独选择三条失败用例得到 **3通过 / 0失败 / 55跳过**；完整58项得到 **55通过 / 3失败 / 0跳过**，与原 CI 的三条尾查错误一致。

1. `0220_digital_production_tasks.sql` 的尾查历史种子是 policy **v1、14400秒**。`packages/contracts/src/digital-sla.ts` 的新确认标准为 **30分钟**。
2. 完整组前序 N01-N11 用例调用 `exerciseExternalCaseNotificationScope`，经真实 `identity.createOrder` → `SlaOrderService.enrollNewOrder` → `SlaConfigurationRepository.initialStandard`，首次追加配置 **v1**；该配置引用追加的尾查 policy **v2、1800秒**。配置版本与节点 policy 版本不是同一编号。
3. `exerciseDevelopmentRoute` 声明测试 Pre-SLA 旧路线，却直接 INSERT source 并遗漏 `created_at`，使其变成前序配置发布之后的当前时间。它没有经过新来源创建 API，也没有 `digital_development_sla_plans` 或冻结配置引用。
4. `frozenSlaTaskPolicy` 的真实优先级为：已有 deadline revision 的 policy → 入组来源/订单的冻结配置引用 → 无计划历史资源创建时的 policy。这个自称旧单、实际创建于新标准之后的 fixture 正确落到 policy v2；单独运行时前序没有初始化新配置，所以偶然读到 v1。

只读数据库采样保留了三个失败尾查的 `state=ready`、`policy_version=2`、`sla_seconds=1800`、来源计划数0；v1仍为14400秒，没有被覆盖。首个失败来源的精确时间证据如下（UTC，保留 PostgreSQL 微秒）：

| 记录 | 实际值 |
|---|---|
| 历史尾查 policy v1 的 changed_at | `2026-10-24 06:34:47.712942+00` |
| 新尾查 policy v2 的 changed_at | `2026-10-24 06:35:04.673062+00` |
| 失败 fixture source 的 created_at | `2026-10-24 06:35:12.323466+00` |
| 来源冻结计划/配置 | 计划数0；没有配置引用，使用历史创建时间回退路径 |

结论是旧 fixture 的来源年代与模型不一致，被前序合法初始化配置暴露；没有发现生产配置冻结或读取把真实旧单改用新标准的缺陷。旧路线4小时断言仍有效，不能改为0.5，也不应把新标准改回4。

### 最小修复与反例

- `digital-development-route-fixture.ts`：仅在合成历史来源初次 INSERT 时，显式使用其路线所需 v1 节点均已安装的历史边界。校验节点齐全且当时没有较新版本，以数据库文本传递时间，避免 JavaScript Date 丢失微秒。发布后断言计划数0；保留 `ready / 4小时`，补 policyVersion=1 和 deadline revision 的 v1 断言。不 UPDATE 已存在的来源或历史事实。
- `development-sla-enrollment-postgres.test.ts`：新增2项反例。来源确实通过真实 API 创建于入组迁移安装前，分别在默认变更前/后创建旧尾查；另建已冻结新来源，延迟到默认变更后才创建其尾查，再建采用新默认的来源。验证旧单4小时、已冻结新单原参数/引用、后建新单新值；旧配置、P0/计划及 deadline 历史不变。没有实际时间时仍可 ready，但 enteredAt/dueAt 为 null；跨来源读取仍404。两个新用例分别独立运行也通过，不依赖前序初始化。
- 完整 sourcing 首次执行暴露另两处同类模型混用：旧同源加轮场景使用真实新来源，客户复版依法生成独立 source；测试丢弃返回的新 ID，仍给原来源登记第2轮事实并期待原任务取消。`bulk-preparation-fixture.ts` 新增显式 `legacyDevelopment`，仅两个历史同源场景启用；其余调用继续真实新来源入组。先断言 publish 返回原 source/round2，再登记测试事实；原过时制单404断言保留。
- `sourcing-pr03-postgres.test.ts`：上述两处选择历史 fixture，新增1项已关联母单的新来源独立客户复版反例。验证新 source 为未关联母单的 draft/round1，原来源、母单、制单历史、准备记录、任务和 SLA 计划不变；工人仍只读原母单制单，对新 source 的开发资料与 Journey 均404。

### 完整组验证、环境与命令

Node **22.22.2**、npm **10.9.9**，使用原锁真实 `npm ci`，锁的 SHA256 前后均为 `fc69a09e506133a069029a0c5abbc50562598f2785978d08fa8fa0a2daaa61c9`；Zod仍为4.6.7。数据库为本机隔离 PGDG **PostgreSQL16.15** 和 **13.23**，最终完整验证使用 `dx_pr854_test` 普通账号，无超级用户、建库、建角色、复制或 bypass RLS 权限，原 `test-database-safety.mjs` 均退出0。JIT保持开启。

按原 CI 映射顺序逐文件执行；下表取各文件最终完整运行结果，迁移兼容与 sourcing 在补齐环境/修复后完整复验，保留第一次失败日志，不宣称一次进程从头全绿。原58项及所有受影响 helper 消费者均覆盖。

| PG16完整文件（`tests/integration/`） | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| acceptance-maintenance-postgres.test.ts | 1 | 0 | 0 |
| development-sla-enrollment-postgres.test.ts | 18 | 0 | 0 |
| digital-budget-shared-postgres.test.ts | 2 | 0 | 0 |
| digital-journey-postgres.test.ts | 23 | 0 | 0 |
| digital-production-identity-postgres.test.ts | 37 | 0 | 0 |
| digital-sla-configuration-postgres.test.ts | 9 | 0 | 0 |
| digital-sla-plan-postgres.test.ts | 4 | 0 | 0 |
| full-business-chain-postgres.test.ts | 58 | 0 | 0 |
| migration-compatibility-postgres.test.ts | 12 | 0 | 0 |
| sourcing-pr03-postgres.test.ts | 115 | 0 | 0 |
| **合计** | **279** | **0** | **0** |

PG13.23 完整开发 **18/0/0**、Journey **23/0/0**（按CI使用 `--maxWorkers=2`）；两个新增默认变化反例分别单独运行，各 **1/0/17跳过**。PG16原三条修复后单独运行为 **3/0/55跳过**；sourcing三个直接相关场景定向运行为 **3/0/112跳过**，随后已完整115项通过。上述筛选运行不冒充全组结果。

实际执行命令的参数形式如下；每个完整文件分别执行，无 `-t`，并保存 default/JSON reporter。映射批次实际通过 npm 的 `npx-cli.js vitest run` 调用，等价于这里的 `npm exec -- vitest run`；执行证据保存了绝对命令与各文件前后源码指纹。

```bash
export TEST_DATABASE_URL=postgresql://dx_pr854_test@127.0.0.1:55416/dx_pr854_test
NODE_ENV=test node scripts/test-database-safety.mjs
npm exec -- vitest run tests/integration/full-business-chain-postgres.test.ts --reporter=default --reporter=json --outputFile.json=/workspace/scratch/6d3c65b5fd2c/runtime/mapped-pg16/full-business-chain-postgres.json
npm exec -- vitest run tests/integration/sourcing-pr03-postgres.test.ts --reporter=default --reporter=json --outputFile.json=/workspace/scratch/6d3c65b5fd2c/runtime/mapped-pg16-recheck/sourcing-pr03-postgres.json
TEST_DATABASE_URL=postgresql://dx_pr854_test@127.0.0.1:55413/dx_pr854_test npm exec -- vitest run tests/integration/digital-journey-postgres.test.ts --maxWorkers=2
npm exec -- eslint --max-warnings=0 tests/helpers/bulk-preparation-fixture.ts tests/helpers/digital-development-route-fixture.ts tests/integration/development-sla-enrollment-postgres.test.ts tests/integration/sourcing-pr03-postgres.test.ts
npm run typecheck
```

4份实际修改TS使用仓库真实 ESLint 配置，退出0；`npm run build:packages` 与最终6个workspace的 `npm run typecheck` 均退出0。workspace tsconfig 不包含 tests 目录，不把 workspace typecheck 冒充测试文件静态类型检查；本记录为 Markdown，仓库无对应 lint，所有差异另经 `git diff --check`。

### 首次错误与验证边界

- 第一次映射10文件为271通过/7失败/0跳过：迁移3项依赖历史 commit `209b00854c217c9fd2e5a6bbc0f5096c0016df0a` 的 `git show`，本地准确 Head 的浅快照最初缺该对象；sourcing两项需要缺失的 `libLLVM.so.19.1`，另两项为上述旧同源fixture错误。已通过 GitHub 连接器补回真实签名commit/tree/4个原blob并校验SHA，未改历史脚本；补齐官方LLVM运行库，未关闭JIT。随后迁移12项及 sourcing115项完整通过。
- 额外尝试在PG13运行完整58项，在原beforeAll直接执行0236迁移时因 `UNIQUE NULLS NOT DISTINCT` 报 `syntax error at or near "NULLS"`：**0项执行、58项跳过、suite初始化失败**。这不是通过。未为此改旧迁移或扩大本轮修复；原CI要求的PG13 Journey兼容用例已完整23项通过。
- 本地为Ubuntu原生PGDG实例，与CI `postgres:16-alpine` / PG13容器的打包环境不相同；这里只声明已执行的数据库主版本及测试结果，不声明完整远端Full Gate通过。
- 准确Head通过原GitHub连接器读取并逐blob验证2627项；5张超过连接器读取上限的历史UI参考PNG未落地，均非运行源码及本轮修改对象。锁文件未手造，源码/依赖限制未绕过；相关环境错误及支持路径已即时回报。
- 本次full-business-chain实测Vitest总59.53秒，主初始化/迁移1859ms、主fixture87ms、清理410ms。sourcing总76.37秒，主初始化/迁移2296ms、主fixture28ms、C05 fixture961ms、清理398ms。其余hook、用例与导入没有在这些分段中全部细分，不能把剩余时间无证归为迁移。
- 本轮没有Work、外部Codex任务、新PR、Review、合并或部署；待负责人审阅本地差异及本节证据后，再按一次性推送854的要求办理。

## 854 mapped 长数据库链超时调查（2026-10-24，仅本地候选，未推送）

前节5文件修复已获批准并提交为 `755db5bc9dadb1a4e989c66c2c10ffe2c1d9c1d1`；前节的“待确认推送”属于当时记录。本节是该 Head 后新发生的超时调查，不能沿用上轮推送授权。开工只读核对远端 Head 仍为755db5b，tree为 `7f77edcf504d7427e7fbe16f72b2771df4572ade`；本节所有候选差异按该tree比较，不把本地旧HEAD下仍显示修改的已推5文件重复提交。

### 原始失败与共同原因

原始证据为 [run 40073216473 / job 120810945881](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/40073216473/job/120810945881)。日志07:23:42 UTC的三例分别耗时5019/5001/5001ms，均为 `Test timed out in 5000ms`：P05 linked execution transfer、P05 native transfer/authority、P03 legacy tail return。完整58项为55通过/3失败/0跳过；没有出现上一轮4h/0.5h断言错误。普通层实际为501文件通过/72文件跳过、2742测试通过/700测试跳过，随后前7个mapped文件通过；不能把尚未执行的sourcing或正式chain计作通过。

已安装Vitest4.1.10的 `createVitest` 实际解析结果如下，不只依赖配置文本推断：

| 入口 | testTimeout | hookTimeout | 数据库环境 |
|---|---:|---:|---|
| 原mapped逐文件 `npx vitest run "$test_file"`，默认vitest.config.ts | 5000ms | 10000ms | DATABASE_URL清空，TEST_DATABASE_URL保留 |
| 原正式chain runner使用vitest.business-chain.config.ts | 60000ms | 60000ms | 同上 |

三条失败it没有独立timeout，所以在mapped入口接受5秒上限。同文件其它较慢用例已有显式15/30/60秒上限；原CI中P07/P08完成23405ms、SLA03完成11833ms、P03 legacy native完成7021ms。这些显式上限在本候选中继续优先，不被默认60秒覆盖。

上轮完整58本地原日志中，三例分别2425.577/2249.874/2456.339ms，确实低于5秒，因此“本地完整58绿”是真实结果，但没有验证CI的5秒余量。此次同机有限诊断也没有自然复现5秒超时，未注入延迟或CPU限速制造失败。可以确认同一长链两个入口的预算不一致，以及完整组有额外查询工作量；不能从被5秒截断的CI日志反推它不受截断时的真实完成耗时，或把全部差异归因于某种CPU/IO因素。

原CI总144.70秒，主schema/迁移4023ms、主fixture144ms、cleanup2900ms；这些分段不能支持“主要时间都耗在迁移”。本轮进一步量化了目标case步骤与SQL，见后文。

### 实际候选及边界

- `.github/workflows/full-gate.yml`：仅在现有mapped循环内，对 `full-business-chain-postgres.test.ts` 和 `sourcing-pr03-postgres.test.ts` 两个精确路径增加 `--config vitest.business-chain.config.ts`。每轮重置参数数组，其它mapped文件及普通unit入口仍使用原默认配置。两份Vitest配置、30分钟Full/5分钟Quick和检查文件集合不改。
- `tests/unit/full-gate-risk-map.test.ts`：新增6项检查，实际执行workflow提取的Bash段，以命令double验证两长文件选配置、普通文件重置、显式测试库缺失拒绝、安全检查失败拒绝、Vitest非零退出即使打印passed也拒绝、全skip拒绝及缺文件拒绝；其中第一项合并覆盖选择和重置。原业务断言和数量不减少。
- 本工程记录只追加本节。没有修改生产业务、依赖、迁移、权限、冻结或历史保护；临时SQL诊断工具仅保存在runtime，不纳入提交。

原 `set -euo pipefail`、显式TEST_DATABASE_URL、安全检查、逐文件存在检查、日志、失败传播及至少一个passed的结果校验均保留。两原配置都清空DATABASE_URL。mapped清理由各suite的afterAll和原workflow停止隔离库负责；仅复用config不会自动获得正式runner的manifest清理。正式runner自身run ID、manifest校验、信号处理与finally清理不变。

风险映射原先用Set合并文件；本候选不改变此去重。mapped与后续正式chain之间没有“已通过即跳过”的跨阶段去重，两个长文件后续仍会再执行。不以完整runner替换mapped命令，避免把runner的整套文件及preflight额外带进每个mapped调用；也不新增成功缓存。

### 本地验证与精确范围

复用原环境：Node22.22.2 / npm10.9.9 / Vitest4.1.10 / pg8.22.0，PGDG PostgreSQL16.15，普通账号dx_pr854_test，JIT开启。没有重装全仓或修改数据库配置。本轮未重跑PG13；改动范围是mapped的PG16入口，不能借上轮PG13证据宣称本轮重新通过PG13。

| 本轮实际执行 | 通过 | 失败 | 跳过 | 说明 |
|---|---:|---:|---:|---|
| 默认入口配置，三目标定向诊断 | 3 | 0 | 55 | 临时插桩，16.260秒命令墙钟 |
| chain入口配置，三目标定向诊断 | 3 | 0 | 55 | 临时插桩，14.849秒命令墙钟 |
| 候选真实mapped Bash，完整full-business-chain | 58 | 0 | 0 | 无筛选、无插桩，Vitest58.58秒 |
| 同一候选真实mapped Bash，完整sourcing-pr03 | 115 | 0 | 0 | 无筛选、无插桩，Vitest70.95秒 |
| chain完整58项SQL对照诊断 | 58 | 0 | 0 | 唯一追加的完整插桩对照，Vitest65.02秒 |
| 入口/预算/schema清理/数据库安全4份unit文件 | 34 | 0 | 0 | 含新增6项，真实文件数4 |

真实候选Bash总130.596秒，从修改后的workflow原样提取执行，原数据库安全检查实际执行。full主schema/fixture/cleanup为1561/76/419ms；sourcing为1764/27/423ms，另C05 fixture812ms。执行前后只剩public schema，当前测试账号无其它会话；记录范围内所有源码指纹不变。两完整原日志仍有pg对同client并行query的弃用警告，没有把警告抹掉或宣称全组无排队。

实际完整入口由 `runtime/timeout-755db5b/run-candidate-mapped.py` 设置原环境和两个mapped文件，提取Bash后执行；下列为已执行命令，非本节要求再次运行：

```bash
python3 /workspace/scratch/6d3c65b5fd2c/runtime/timeout-755db5b/run-candidate-mapped.py
# 提取的Bash中两文件分别实际调用：
NO_COLOR=1 npx vitest run tests/integration/full-business-chain-postgres.test.ts --config vitest.business-chain.config.ts
NO_COLOR=1 npx vitest run tests/integration/sourcing-pr03-postgres.test.ts --config vitest.business-chain.config.ts
npm exec -- vitest run tests/unit/full-gate-risk-map.test.ts tests/unit/unified-gate-budget.test.ts tests/unit/business-chain-schema-cleanup.test.ts tests/unit/test-database-safety.test.ts --reporter=default --reporter=json --outputFile.json=/workspace/scratch/6d3c65b5fd2c/runtime/timeout-755db5b/entrypoint-guards-final.json
npm exec -- eslint --max-warnings=0 tests/unit/full-gate-risk-map.test.ts
node scripts/ci/verify-actions-policy.mjs
```

唯一修改TS经仓库真实ESLint退出0；Actions政策检查输出ACTIONS_USAGE_POLICY_OK。仓库没有Markdown/YAML对应ESLint规则；Bash实际执行及全部差异另做diff检查。本轮没有生产TS变化；workspace tsconfig也不包含tests，因此未重复全workspace typecheck，不能把Vitest转译称作完整静态类型检查。首次新增测试曾因模板字面量转义错误解析失败，已修正；默认沙箱还拒绝原预算测试spawnSync node（EPERM），随后在受支持执行权限下完成最终34项。首次失败日志保留，未假报通过。

### 每case查询、步骤、锁与泄漏证据

诊断只统计Client.query，不重复包Pool.query；Pool.connect仅记录借连接。100ms独立只读采样不纳入业务SQL；helper的206个await通过临时Vite变换标记，原文件字节不变。以下是query调用次数，不拆分多语句调用或数据库函数内部SQL，也不代表一次用户点击的查询数。

| 目标case | 隔离三例中的SQL | 完整58中的SQL | 增量 | 完整组case墙钟 / driver SQL累计 |
|---|---:|---:|---:|---:|
| P05 linked transfer | 10805 | 12271 | +1466，13.568% | 2875.624 / 2554.331ms |
| P05 authority transfer | 10439 | 11849 | +1410，13.507% | 2670.721 / 2329.962ms |
| P03 legacy tail return | 11114 | 12530 | +1416，12.741% | 2673.997 / 2331.884ms |

完整组确有查询数量增长。材料复核反例步骤分别3727/3782/3841条SQL、832/742/798ms，比隔离多342–347条；安排反例1651/1662/1693条、382/378/371ms，多193–213条。两转派guard分别1701/1095条、381/309ms。完整execution.read寻找单任务的9/9/10次读取仍约1053–1156条；不能删除权限、并发、事务、幂等、补料实收和历史反例来降低这些数字。

增长模板包括每例权限身份读取+311–322次、表存在性检查+234–240次、SLA计划+82次、标签+170次、部分资料/轮次读取+30次。`development-notifications.ts`、`development-arrangement-todos.ts`及面料case列表存在遍历符合条件source的读取，与完整组前序数据增加相符；未经逐条调用链归因，不能把全部增长都归给某一个函数。`development-execution-service.ts`已经使用同一REPEATABLE READ只读事务内的snapshot读取复用，不能误称没有缓存或随意跨写事务缓存权限/材料事实。

三目标在完整诊断中结束时均0在途query/0未归还lease/0结束后query/0跨case标签重叠；池获取最长0.928ms。确实采到3条advisory锁等待观察，query年龄约6.4/12.1/16.7ms，未看到秒级持续阻塞。100ms采样不能排除短等待，也不能用观察次数乘100ms计算锁耗时。最终8个被观测应用池全ended、连接和query归零。

完整组另有必须保留的诊断局限：较早case18/21/22出现3对共847次跨标签配对计数，以及61+33条带旧case标签的结束后SQL；847不是独立SQL数。94条均落在后续N01–N11用例时间内，内容是其外部责任读取；Pool排队回调没有重新绑定调用者上下文，提供了可信的AsyncLocalStorage归属漂移解释。现有记录缺少Pool.query入口归属、调用栈和参数，不能最终排除真实异步延续，也不能判定连接泄漏。异常最晚24.870秒结束，三目标在50.627–58.955秒执行，没有时间重叠；不得把三目标的局部零残留写成完整58全程无异步重叠。

SQL累计包括驱动/网络/等待，不是PG CPU时间；嵌套步骤墙钟不能相加。完整诊断计账1158.466ms、落盘1577.184ms、610次采样累计769.932ms，存在并发及未量化调度开销，不能简单扣除。闲置连接距最后CREATE SCHEMA的query年龄不表示迁移仍在运行。本机没有自然复现5秒失败，CI没有SQL/锁采样；本候选解决入口预算不一致，未优化这些SQL，也不声称性能已根治或远端Full Gate会必然通过。

### Actions范围、成本与停止点

本轮只读现有日志，新增Actions运行0。原失败job从07:12:25至07:23:46 UTC，共681秒（11分21秒）；其中普通测试242秒、mapped261秒。它在mapped提前失败，后续PG13、Root、正式chain、备份恢复与Acceptance/package阶段没有执行，不能据此估算完整成功耗时。

候选3路径独立分类只触发deployment类，映射出的maintenance/migration两文件都已在原CI记录的10文件集合中；原CI风险输出也已要求business/migration/deployment/PG13。本地浅快照缺历史Base对象77a15f2，额外比较整PR路径时报 `fatal: bad object`；未补全仓库，范围核对使用已读取CI原风险输出和现有分类器，不假称重新计算了完整PR差异。相对当前755db5b tree的3文件差异及验证不受此限制影响。

若负责人以后明确批准推送，按当前[FULL]标题及原workflow是一次Full Gate job、30分钟上限，Quick job按原条件跳过；原后续检查范围及跨阶段重复执行仍保留。60秒是单case/hook截止上限，不是每例固定增加55秒；真实挂起会等待更久，仍可能受30分钟总预算限制。未取得账单/额度信息，不编造费用金额，也不以本机130.596秒预测远端整次费用。

本轮证据位于 `runtime/timeout-755db5b/`：原CI日志、resolved-entry-configs.json、candidate-mapped完整两组原日志和execution.json、entrypoint-guards-final、两次三例profile及chain-full58原始记录、full-vs-isolated-summary.json、actions-cost-evidence.json。仅提交可审核的本地diff与结果；没有push、dispatch/rerun、Review、新PR、merge、deploy、Work或其它分支动作。下一次远端写入必须由负责人重新决定。

## 2026-10-25 Review 与 main 转厂修复同步

- #857 的最终 Head `3f6c7e8a0392137e1067c02dfb8e498c3a0c7fbd` 已经 Full Gate 和 Codex Review，merge commit `67841e105fe7090e219477171d3cf79565719241` 合入 main；未部署。
- #854 两项 P1：工艺回收确认错误地以父计划末段推造实际开始；缩短路线遗漏原车板实物接收条件。实际起点改取同轮有效原工艺完成事实，未知仍未知；已保存错误起点的只读投影同样按原事实解释，不改 P0、原截止或持久化历史。新直达和旧跳过转交路线均保留原实收条件及审计；旧已存在转交、继承车板和工艺布片路线不扩门禁。与裁床收布无关。
- main 转厂 SQL 原文及 checksum 原样同步，两个 0230 身份分别登记，扩展原 main lane 和 Acceptance inventory；不恢复仅属于 main 的 maintenance 工具，不把整条 main 合入 SLA。保留集成页面既有请求反馈/财务视图；只同步转厂错误分类、安全诊断和就近提示。迁移兼容 fixture 明确旧 release 尚不含新的 main 0230，并同步 current main 230 条数量断言，负例保留。
- 本地使用 Node22.22.2；P1/开发路线/计划/读取/检查相关5文件64项通过；转厂及迁移相关8文件66项最终通过（main-release兼容旧 fixture 首轮失败后更正并完整14项通过）。候选自有 packages 重新构建，API/Web typecheck及实际修改文件限定 ESLint 通过。未运行本地 Full；本环境无现成隔离 PostgreSQL，真实 PG、迁移升级、恢复等由新 Head Full Gate 验证，不能将以上单测称数据库验收通过。
- Chromium实跑390/1440下四角色转厂、失败保留输入/请求号/幂等键、切单隔离及成功后刷新失败不重复提交等共13个前置场景，截图保存在本地工程目录之外。完整继承浏览器脚本随后在原合同周期 fixture 的“本版本 V7 无回签记录”处超时；此项未验证通过，未为此修改合同业务或删除断言。截图为组件 fixture，非部署后全应用验收。
- P9/P10/验收时钟未纳入；未触碰 WIP、生产数据或部署。新 CI/后续 Review 状态以 GitHub 对应 Head 为准。
