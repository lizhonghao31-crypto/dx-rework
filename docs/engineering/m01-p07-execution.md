# M01 P07：短交期原岗位申请、批准与正式确认

本轮后续多场景接入按[浏览器与集成测试集中检查清单](m01-browser-canonical-checklist.md)执行；每次最终请求仍须提交实际命令、环境边界、场景/清理报告，清单本身不是通过证据。

依据完整Library施工方案v1.1.1 §10.1–10.2及OPT1.3 §6.6。用户授权本轮施工、正式Codex Review及按顺序合并；P06 #907检查等待时，本工作树独立准备，不改P06冻结候选。最终部署仍由用户操作，不操作ECS、生产资料或独立Acceptance诊断现场。

## 开工与依赖

分支`m01/p07`，独立工作树`/workspace/dx-rework-m01-p07`；准备基线为P06候选`55d21f804f4d5dbc527100cea984fd9838ce9cca`，实际集成分支仍`f2cc977bbd7efce09dc2d0c5e7a51aac05608c6e`。P06合并前不创建或合并P07；以后核真实merge/tree并对齐，再绑定最终检查。自己的node_modules副本及相对workspace链接，构建输出分离。风险FULL：原正式确认、审批、幂等与角色入口跨模块。

## 实现前影响记录

| 批准规则/来源 | 写入口、读取及旧消费者 | 初始化、日期、权限边界 | 验证命令与预期 |
|---|---|---|---|
| P07-01/03/04；OPT1.3 D11 | 原DevelopmentCreateForm保存/发布/确认顺序，short-lead-evidence有限draft→published规则，原DevelopmentService | 不改原版本、完整内容指纹、scene、消费守卫；先证明客户端额外保存的技术反例，不能把它称O现场唯一根因 | 原组件与PG对同内容跨日、JSONB键序、正常发布、实质变化逐项验；保原旧反例 |
| P07-01/02/05/08；D12 | 原ShortLeadPanel及ShortLeadService；原我的待办/深链/原来源办理入口 | 原设计师申请，老板节点只老板或Root，生产管理不能审批；审批不要求先获技术编辑权；每份原因独立；正常入口迁移成功前不移除唯一入口 | 专属正常设计师/老板fixture完整链，29/30/31、权限允许/拒绝、列表刷新失败与切单迟回 |
| P07-06/07 | 原IdentityService确认/建单与consumeShortLead原事务 | 不新增平行审批系统，不回填O批准；只一正式单与一次消费，原失败全回滚；无结果核对能力不能另建新来源 | 原PG同key、异key并发、建单/消费中间失败及原请求恢复；保原审计 |

## 开工核查记录

`shortLeadDocumentHash`已规范对象键序；`shortLeadStaleReason`仅接受相同版本或draft→published恰加1且完整指纹一致。开工时客户端保存判断直接`JSON.stringify(sheet.document)!==JSON.stringify(persistedDocument)`，PostgreSQL JSONB键序与表单对象键序可以不同；若因此额外PUT再publish，版本恰加1的有限兼容不能覆盖。这是需由真实组件/PG反例确认的技术机制，未取得O当时请求链，不写唯一根因结论。

原正式确认已位于生命周期事务锁、来源FOR UPDATE与批准消费同事务；继续按真实反例验证，不凭静态阅读签原子通过。原ShortLeadPanel只有面板级一个理由且无独立迟回归属；当前老板入口位于设置旧区域，尚未接入正常待办。以上为待施工范围，不是完成状态。


## 独立准备实现（P06尚待最终Full）

准备树先从55d21f80完整保留自有修改，并依次快进到01e912fd、126a4738；自有stash c749044f、aa9528b4仅作任务恢复副本。此处不是实际合并基线，P06真实合并后仍须核merge/tree重新对齐并验证，不提前创建或合并P07。

- `sameDevelopmentDocument`与原`shortLeadDocumentHash`一致，仅递归规范对象键序，不忽略业务/技术字段或数组次序；表单只跳过真正等价的PUT，原版本、scene、完整指纹及消费守卫不改。原PG反例复现：旧额外PUT再publish使版本加2，仍正确拒绝旧批准；修复流程只publish加1，同源28天、北京跨午夜保持有效。
- 申请仍从原DevelopmentCreateForm/ShortLeadService；申请前保存失败会明确停止，不吞错误继续申请。已知短交期在提交链开始前读取该来源的真实批准，避免列表尚未返回就仅发布而漏接正式确认。原一键连续发布/确认保留。
- `shortLeadTodos`接原DigitalProductionNotificationService与原TodoService/MyTodosPage，使用原source技术读取、实际active角色和`acceptanceIncludesNative`，普通视图不混入scene。老板只审批、无技术编辑权；经理不获老板权限，也不扩他人申请历史范围。新route经过原目标映射/返回路由/内容已读；明确站内，不新增外部通知或平行审批表。
- 原来源审批工作区按申请ID保存各自理由，显示客户、PO、颜色、尺码数量、承诺基准、申请/当前资料版本、差异和历史；资料完整指纹变而旧申请无逐字段技术快照时明确未知，不编造变化详情。批准、已发布、正式确认、批准消费分开呈现。
- 正式确认失响应保留同一source/body/key并锁定原命令核对，成功后才显示原正式单编号；后续来源503也保已知正式成功结果。已发布但明确确认失败保原发布与批准，普通重试沿原单，不新建来源。A1/B/A2的迟回、error/finally和身份变化均按归属隔离。
- 正常岗位原生入口闭环已实际通过后，SeriesSettings旧申请列表迁为规则说明及本人待办链接；原来源申请及批准历史仍原接口读取，不删O或旧批准。原Root自己执行例外仍独立保留。

## 准备阶段真实验证

仅使用已核低权限标记库dx_m01_acceptance_test_dc924aaea2/OID694046和原ownedPostgresSchema；PG组顺序执行，结束后验证0任务schema/0其他连接，不清未知资源。Node22.22.2/npm10.9.9、Vitest显式worker1；浏览器采用Playwright-core1.56.1锁定Headless Shell141/build1194，1440/390实际页面。未将本地并发或硬件称作CI等效。

`series-plan-postgres.test.ts`准备阶段23通过：包含29/30/31、真实设计师/老板/经理/Root/无scope、普通视图scene隔离、原样跨日、实变拒绝、同/异key并发；消费前注入自有schema专属触发器错误后，原事务无半单、无根孤儿、无独立消费，删除该TEST触发器后原key恢复只一单一次消费。没有关闭或移除生产守卫。

新增canonical `m01-short-lead-native-browser-postgres.test.ts`实际1通过，内部完整9组浏览器断言（不是另外9个独立Vitest测试）：原设计师保存申请、老板正常本人待办审批/无技术编辑、A/B原因隔离、发布成功失回执原命令恢复且来源503保结果、已发布确认失败恢复、经理不能审批/读他人历史、A1/B/A2迟回、原AuthService同有效专属会话撤老板角色、原Acceptance控制/业务认证及HTTP时钟跨午夜到发布正式确认。授权身份未用Root替代；仅外部钉钉与具名传输丢失为TEST适配。

该套件加入原有限正确性配置、敏感输入映射及原按需Chromium准备；结果放原settings native artifact目录下的自有子目录，保原Full预算/权限/tuple/资源协议，不新增流水线。preflight新增明确计划映射和非相关计划不安装的反例；242通过。时间清单只更新ShortLeadService一条DTO装配行的来源摘要（7个原时间点数量未改），原ContextBusinessClock/day语义未变；447个无关人工注记逐字保留，旧语义记录保留来源。此为准备阶段证据，最终head及正式Review/Full另行绑定。

未取得O当时完整请求链，额外等价保存只是已复现且已修的技术机制，不写O现场唯一根因；不回填O批准或倒退现场状态。D11/D12须在实际合并基线、最终检查及完整岗位闭环均满足后按已证范围收口，真人试用、部署与现场快照身份仍单列。

### 同类浏览器边界集中处理

P06的整组60秒超时促成同类入口排查。本项9场景原包装在一个it，现保原业务断言/原服务/认证/fixture/finally，以async generator逐场景顺序运行，9项分别报告耗时加1项完整列表及收尾检查；原60秒及two-worker配置未改。所有调用方为canonical及CLI，均实际完整消费；未完成迭代由afterAll return，不把部分执行当通过。

准备源码099eec20下，锁定Chromium141的canonical10/0/0、CLI9/0/0、preflight242均通过。canonical命令未覆盖maxWorkers，实际原business-chain配置解析为2；旧私人记录器的workers=1是记录提示错误，以实际命令/配置和原JSON结果为准。CLI首次私人启动未传专用证据路径，在fixture创建前明确拒绝，补齐原必需环境后才实际9项通过；没有修改业务或放宽安全检查。最终P06合并后仍同步其真实两文件执行边界及实际merge基线，并核受影响组合，不把当前准备Head当最终通过。

在改变两个PG浏览器执行文件前，03:54已对仍与508f78e5完整准备来源一致的其余2378个输入捕获明确指纹；完整non-db3380/0/11、series原生PG23/0/0及类型/构建保留实际旧testedHead/source/log，不冒新来源执行。仅原生四个文件排除，已知P06两文件须来自其最终实际合并；受影响的原生组合和便宜检查重新执行。最终GitHub light/Review/Full不跨Head复用。

### P06实际合并基线与最终组装

P06 #907最终ea4e715e在Full42160132408/Final Gate127710437769完整通过后，squash合并为3a4d158795bd26bc0814bc28cf007fd908f3d9ac；合并树3e7819690f24706408a446591f380e8d6b3aa820与候选一致，父为f2cc977b。显式refspec更新并核远端tracking与实际引用均为该SHA，未以FETCH_HEAD冒同步。P07全部自有修改通过stash9a8dc979保留并应用到实际merge基线，无冲突，恢复副本保留。最终源码指纹b418cdb6bda6e58fea7b554e5bdbfd0408605716f919209bd9f1c7cc46c5b591，已包含P06逐场景原生执行边界。

原P06候选被squash后，准备测试的126a4738并非该merge的祖先，原construction-evidence不允许把它绑定为最终祖先来源。因此旧明确输入范围证明仅保留准备记录，最终组装在实际3a4d1587上集中执行一次完整non-db、便宜检查、同版浏览器原canonical组合及CLI；不改既有证据政策或制造提交保留旧Head，不把准备结果冒最终通过。当前命令运行结果收齐后再提交一份完整P07。

### 用户追加的100秒正确性余量

P07首次组装在b418cdb6实际完成8项检查：完整non-db3380/0/11、原canonical58/0/0（设置25+短交期10+series23）、CLI9/0/0、preflight242及lint/types/build/secret均exit0。但提交前用户随后明确要求以后同类场景提高到例如100秒，故该首次结果作为已完成历史记录，尚未据此申请P07 Full。最新要求纳入P07同一最终候选，保持P06已合并版本不动。

统一权威scripts/test-execution-config.mjs的correctnessTimeoutMs由60000调整为100000；business-chain和postgres-immediate的testTimeout/hookTimeout共同引用。原Vitest普通/性能配置仍默认5秒test/10秒hook，未更改其禁止全局放宽契约；它的重型PG测试显式覆盖另按正确性预算处理。通过TypeScript AST定位实际Vitest test/hook参数及其options.timeout，共31个原生PG/集成文件的116处15/20/30/45/60秒覆盖改为引用权威值；既有120/240秒等更大预算逐项保留。不是文本替换所有数字，页面单操作、日期、业务SLA及性能断言未改。原CI job30分钟、父runner进程组SIGTERM/SIGKILL升级及失败资源保留规则不变。原runtime metadata已实际解析两个正确性配置为100000ms、worker2/1，普通配置仍5000ms、worker1。

便宜预检首先明确拒绝8个本次触及的旧夹具裸schema DDL。集中盘点后，仅把其创建/登记/释放接到现有createOwnedPostgresSchema/releaseOwnedPostgresSchema，沿原已注册prefix；auth_revoke原随机裸名改为原已注册生成器。clock相关资源声明实际acceptance-clock目标。未给preflight加例外或关闭守卫，业务断言与原低权限/同会话撤权不变。该必要配套随最终新源码进入原组合验证，禁止旧结果冒新通过。两个本地目标dx_rework_ci/OID16387与dx_m01_acceptance_test_dc924aaea2/OID694046均已只读核原隔离标记；不同目标身份不会用同库伪造。

最终集中预验扩大为全部被改预算的31个原套件加设置/短交期/series，使用原canonical runner、同版141及两个真实已标记隔离目标；ordinary worker1、isolated worker1、long worker2均按原配置。Node/浏览器affinity0–1不是PG宿主等效。结果、资源收尾及尚未等效项收齐后再冻结/提交/Review/Full，不用Full调试未完成候选。

### 扩大预算接入后的集中旧消费者闭合

final2原runner按34个请求套件自动补入3个Root审计（supplier maintenance/onboarding、quality basic），实际37个唯一套件；ordinary阶段发现失败即停止后续配置，不能报告整组通过。完整non-db3380/0/11及preflight243、lint/types/build/secret在54db5fd5通过，但PG失败使该来源不能提交验收。没有启动P07 Full。

集中读全部失败报告后区分：批量补import造成digital-journey重复声明（本轮引入，已修）；clock前缀目标不符合原资源契约（配套引入，已改用原唯一支持acceptance-clock目标的business_anchors前缀，未放宽契约）；其余为本次纳入的旧夹具/旧消费者不满足现行规则。尺寸表显式提供M/L、制作量及测量值；原生返工尾查按原已发布胸围尺寸报实际值；未来时钟的原读取也留在原runtime.run域内，不把业务时间改回真实今天。

临时特殊工序升级仍以真正main230起点加原hotfix再升完整release；原main注册新增0232后，历史main230集合现明确截至230，仍核230条及固定历史尾版。旧279/0265尾版断言改为逐条核当前提交manifest版本和checksum、保原历史applied_at及所有业务事实；不是删掉升级完整性。当前manifest288条、尾0273，原全部SQL逐条核摘要。

原我的待办新增合法准备任务后，原目标任务仍须找到；同一列表每项都核原技术权限及同一款上下文，继续拒绝无关人/他人数据，并保隐私字段反例。开发核配旧文案改对现行“文员核配委派”，不改岗位权利。接受时钟夹具保留真实员工拒绝；共享TEST安排/定位助手通过原acceptanceBusinessContext.acceptsActor挑当前场景原有有效候选，不能随机LIMIT1选到专供拒绝反例的real-person。原owner时钟构造不再向固定旧日期倒退，改从原scene.now逐毫秒向前五步，仍核第6版及精确原时刻。

上述8个失败套件先做定向复验，6个已通过，剩余2个时钟套件修复后41通过/1个原外部live浏览器条件跳过；实际live URL未配置且本轮不部署，未把该项写通过。P07新原生浏览器仍独立真执行、不依赖这项可选live路径。随后按冻结新源码集中重跑实际37套件组合和完整便宜检查，final3结果才用于组装。31个重型PG文件除了显式test/hook参数引用100秒，还用Vitest原生vi.setConfig将本文件默认test/hook设为100秒，保全局普通/性能5/10秒和更大120/240秒覆盖。没有放宽实际业务SLA、性能数字断言或页面操作等待。


### final3实际集中结果（提交前）

真实base3a4d158795bd26bc0814bc28cf007fd908f3d9ac，完整来源指纹a156dc59a40bf781a5a24f1a47ed7c1c60a906f06dd52b043fbd3bd29e6244bf在命令前后相同。原canonical实际37个唯一套件、3个顺序配置：ordinary311通过/0失败/1原条件跳过，immediate60通过/0失败，long231通过/0失败；合计602通过/0失败/1跳过。原runner确认59项本run自有资源清理完成。唯一跳过仍是未配置外部live Acceptance浏览器URL的旧条件用例；本轮不部署，未冒称现场通过。新短交期原生9场景及完成检查实际执行通过，另CLI9通过；二者覆盖重叠，不累加为不同业务场景。

完整non-db3380通过/0失败/11原可选跳过，preflight243通过，lint、typecheck、workspaces build、secret scan均exit0。日志及三份原Vitest JSON真实摘要随当前construction-evidence固定；PG命令05:00:52.671Z开始，05:10:05.834Z结束。Node22.22.2/npm10.9.9、Chromium141.0.7390.37/build1194；双标记低权限PG16.14分别OID16387与694046，original ordinary/immediate worker1及long worker2。Node/browser affinity0–1与静态检查2–3不代表整个PG实例或GitHub CI硬件等效。

实际Full风险计划尚需由最终PR验证：预计原canonical53个唯一套件，含既有chain/Root与其他风险映射；本地37项不冒称全部53项通过。官方Codex Review、准确最终head的light与Full尚未执行，提交、合并和部署各自分开记录。

双目标只读收尾复核：专属clock库0schema/0其他连接；default隔离库0其他连接，存在8个不属final3 runId4e9d82f2的schema，归属未证实，未删除或声称全库为空。原runner仅对本run精确manifest59项逐项删除并SELECT确认不存在；其cleanup通过只覆盖本run，不能解释其他历史资源。


### 官方Review与集中修复

#908官方Codex Review在49dd666cec92fe539ee5d1846a19681fa20facc7完成，2026-11-06T05:26:27Z，发现一条P2（comment4489338054）：兼老板/设计师的普通用户本人申请被投影成不可自办的审批待办。原decide拒绝自批的服务守卫保留；读取按每份请求返回canDecide，原待办和按钮共用该结果，普通老板本人申请不再显示可办决定，Root自办特例仍可用。

专属新TEST身份由原AccessMasterDataService赋实际双角色，不改变既有纯岗位fixture。原PG定向25项通过；原AuthService/真实认证浏览器增加一个多角色自批场景，原9场景全部保留，共10项CLI通过：本人无待办/批准/驳回按钮，真实HTTP批准及驳回均403，其他老板正常批准后本人仅一个原正式确认待办；Root自己申请仍有待办且真实原按钮可以批准。定向结果绑定修复来源6ad4153a9e56dd18ce93b80dc99f1cc3e8295c42b0acc690569e97a7815a0b63；该CLI在完整来源冻结后实际执行，后续源码未变时直接复用该次真实日志，不再无意义跑一次。其余受影响集中组合/检查在同一修复来源收齐后才推送最终候选并申请Full。旧官方Review覆盖49dd666c，不冒称修复提交已经重审。


final4集中结果：来源6ad4153a9e56dd18ce93b80dc99f1cc3e8295c42b0acc690569e97a7815a0b63前后未变，testedHead49dd666cec92fe539ee5d1846a19681fa20facc7。原canonical37个唯一套件605通过/0失败/1原外部live URL条件跳过；原runner本run0557c031精确59资源已逐项确认删除。完整non-db3380通过/0失败/11原可选跳过；preflight243通过；lint、typecheck、build、secret scan均exit0。原CLI10项在同一完整来源下已执行通过，以原review-native-fix1的实际开始/结束/日志保留，不虚构另一次运行。上述均为本地最终候选验证，准确head的GitHub light/Full仍须实际完成。

集中核查本轮短交期待办、读取、面板与decide全部审批/申请人谓词：服务实际角色校验与decide原自批拒绝保留；global canApprove只表示有老板角色，每份canDecide才决定待办/本份按钮。确认待办仍要求实际设计角色及本人原申请且已批准，不因老板身份串入他人确认或使结束项复活。后续实际Review回执、最终head、Full及合并另记，不把旧49dd666c审查冒修复提交重审。


### Full42170247233实际外层超时与后续修复

最终e1c695e6的light42169878759/job127734944035成功，外置包9eacc4c1经原request-final preview/apply逐字核定后创建一次原不可变引用。Full42170247233/attempt1的common127736220016和non-db127736606283成功；PG127736606249在05:46:35开始、06:16:55结束，状态cancelled，Full聚合及Final失败，不能合并。日志SHA60c0f03bdf7273525fd6858201a6f0a728cc704fd21cc158fbd75aab081f1ef3保留。

原公共风险输入确认为mapped36、chain true、deployment true，原准确head计划解析53个唯一PG套件（普通30、isolated1、long22）。原本地受影响组合37通过不等于53通过。CI普通30套件327通过/0失败/1原条件跳过，墙钟1245.57秒；隔离1套件60通过，154.52秒。最后22套件组仅部分结束，最后完成series25的时间06:16:37，06:16:50出现operation canceled。总计可核完成36个文件、501通过/1跳过，剩余17文件、整组收尾与后续兼容/恢复阶段未完成，不能签PG通过。日志未出现100秒单用例超时或断言失败，仍持续输出，结合原PG job有限30分钟与实际30分15秒停止，支持外层总预算不足；本窗口未取消或重跑。当前连接器不支持check-run annotations，未据此声称取得取消人或额外审计原因。

依用户最新要求核整条外层边界，最小调整仅PG完整lane为有限60分钟，common/non-db仍30、聚合2、light5及元数据2不变；policy仍精确核4个job各自预算，非取消检查。原test/hook100秒、保留120/240等更大覆盖、业务SLA/性能断言、worker1/2、进程组SIGTERM/SIGKILL和原精确清理不变。PG前两组已用23分20秒，22套件长组及清理、PG13/恢复/实际适用的既有演练仍需预算，故不把外层仅提高到略超已失败30分钟。

改动前06:23:27.387Z在6ad4153a源码捕获明确2379文件/108输入scope（仅排除本轮3个CI预算/协议文件），摘要b06a261038cc2227f6df321942340c9aabb8cd226d6d5542f5ee655262c61dae。只对确不依赖这3文件的原types/build/nativeCLI本地结果保原来源复用；不会跨head复用GitHub Gate。新最终候选先按原完整53计划集中验证、协议/受影响检查与真实资源收尾，并核后续外层阶段；未完成不再申请Full。

### final5完整计划及预算修复预验

新源码7489116e1fa474921ae5bd563cbf6e321826a7fa326f2e0c76d27f4a5dd4ce22在全部新命令前后未变。原`--full-gate`入口按真实已发布风险输入解析53个唯一套件、原三配置执行：776通过/0失败/1原可选live URL条件跳过，原精确登记资源清理通过；06:32:57.831Z至06:46:35.020Z，用时13分37秒。并非再跑37套件冒完整计划。单独原PG13 Journey兼容入口亦通过，实际版本130023，自有子容器由原finally删除。

完整non-DB3380通过/0失败/11既有跳过、原preflight243通过，lint与secret scan成功。types/build/原生CLI10项仅按编辑前捕获且未变化的明确输入复用，原49dd666c testedHead、时点、日志和6ad4153a来源保留，不改写为本次重跑。construction-evidence区分当前完整来源与inputFingerprint复用，新增第7条外层预算规则。

本次完整数据库预验使用与CI同一不可变PG16-alpine镜像aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139，实际16.15，原低权限CI测试及NoLogin夹具角色、标记明确的独立default/clock库。Node与浏览器affinity0,1、PG cpuset0,1/2CPU/2GiB；不声称宿主IO/整机与GitHub硬件等效。起初旧共享服务器缺原夹具角色被守卫拒绝，未修改共享角色或绕过守卫，转用全自有容器。结束核default/clock自有schema均为0后，按记录的完整container ID、名称、创建标签删除该唯一容器及卷；不清未知旧资源。

原失败Full42170247233永久保留失败。新最终提交仍须准确head的正式light及Full全部步骤完成，未在本地重跑的原恢复/发布包演练由正式Full按真实适用条件执行。没有部署、ECS操作或真实业务数据变更。
