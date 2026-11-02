# PR07 相关单据执行记录

目标：按批准计划PR07及26来源矩阵补齐原单读取；现有三栏、导航、款图、七阶段和办理按钮保持，10个生产入口及右下角“查看全部”使用原组件与局部CSS。目录仅只读，无新事实表、流程门禁、角色授予、部署或PR08清单。

实际base：`7ad6d990d523eb82eba5563981aa525156340633`；分支`feature/new-flow-p07-20261102`；FULL，一次Codex Review后集中修复。已获全程施工及逐PR合release授权；不合main。

## 影响闭包（实现前）

|规则/来源|写入或读取入口/旧消费者|初始化/历史边界|必要验证与预期|
|---|---|---|---|
|批准10类入口|cockpit-documents-model/catalog、CockpitDocuments、CockpitDetail|类别不是新表，缺少/失败/无权区别；不伪有效|旧directory/snapshot单测保留负例，新10序/所有分类|
|26来源完整读取|quotation、technical、readiness/bulk、factory-flow、closure、receiving document-history、rework business-detail原GET|同原权限，引用原版；PLT/尺寸/评语不混最新和采用|逐源真实/空/坏数据/版本/跨单及原下载反例；不以mock代后端鉴权|
|范围资料凭证|ProductionReadinessService.read/canDownload及原range命令|原表evidence_ids/basis_json，不新增上传/授权；精确订单关联|真实原range保存->原只读->原下载允许/跨单拒绝|
|历史报价直达|DigitalQuotationPanel现history读版本|明确正整数版本，非法不回落当前；原历史只读|实际链接生产者与历史请求/不可变资料|
|返回上下文|JourneyReturnContextSchema/cockpitQuery/digital-cockpit-page及原链接生成|本地窗口/筛选/滚动/焦点不进入列表API，不重挂原办理表单|真实父页打开/搜索/返回/切单/键盘及旧URL守卫|
|权限与缓存|原auth-session +目录snapshot +原API/下载|角色/身份切换与拒绝丢弃旧数据，隐藏计数不泄漏|原403/404/错误/晚回复/并发3/分页负例，真实权限链|
|统一UI|原CockpitDetail/Document Entry/native dialog/focus trap/tokens|仅局部样式，不删字段/换组件库；PC优先保响应式|1280x800/1440x900同数据前后、长名/多记录/空/失败/键盘|

## 已执行

- 初始base `npm run test:preflight` exit0，TEST_PREFLIGHT_PASSED；这是基线静检，不代表待实现功能已通过。
- 精确依赖沿用相同package-lock的已安装目录，不升级依赖。apps/web没有独立node_modules，无需复制；根workspace依赖已就位。
- 已读AGENTS V3、批准计划PR07/UIC/26来源表、权限Golden及UI规则相关执行约束。两次PR06遗漏和失败回执保留，不标为通过。

实际命令、日志、source/input fingerprint、退出码及通过/失败/未测边界见当前 `construction-evidence.json`。本地记录的 testedHead 为祖先、输入为工作候选时均显式注明，不将其称为已提交Head或最终Gate。

- 首次本地PG在导入阶段即失败（0业务用例/0资源）：新worktree已复制依赖但未构建packages/domain运行导出。已一次补齐config/domain/ui运行依赖构建，再运行原套件；不放宽DB守卫，不将未执行用例称通过。该本地初始化遗漏保留原失败日志。

## 26来源接入对账

以下是原资料的读取分类，不新增26张表。入口类别、原单实例、有效版本和附件分别处理；无权先由原GET拒绝，客户端不读取后再假遮挡。十类首页顺序是批准的业务预期顺序，不是访问日志排名。没有权限或不适用可少于十类，不从其他类补位。历史附件沿原私有下载入口核权，不缓存临时URL。

|来源|当前读取/原办理来源|展示与版本边界|
|---|---|---|
|1 大货制单|原 orders/:id/instruction；model|草稿与发布版、原尺寸采用依据、原图；历史版不落回当前|
|2 QC进度/产量/照片|原 qc-production-progress；production adapter|同次观察及关联报量/照片；补照片不更新进度时钟，不自动质量合格|
|3 大货纸样/唛架/尺寸|bulk-preparation.readiness.ranges/tasks；技术原history|范围成果凭证/采用依据与原任务；局部完成不代表整单开裁|
|4 物料/验布/预缩|bulk-preparation.materials.history/fabric/readiness；固定 history GET|原发料、有效物料版、验布报告/质量决定、预缩任务；报告与决定历史20+1分页|
|5 裁床/士啤片/实裁/订正|Journey cutting引用→原cutting/orders/:id|原裁床范围/实裁照片/订正，入口不是另建裁床单|
|6 裁后工艺/仓库发厂|factory-flow.facts/checks|实际工艺收发、检查及仓库发厂；不混旧到料清点和船样|
|7 真实回货/成衣QC|closure.lines/quality→receiving document-history|真实批次/实收订正、有效数量版QC及历史；日期精度沿原receiptTime|
|8 装箱/数量差异|同原document-history.packing/resolutions/files|实际装箱和差异凭证，不以判责/财务签字新设前提|
|9 合同/回签|原sourcing contract-directory|合同文档ID绑定本版回签；无历史归属明确提示，不按最新文件串配|
|10 预算|原budget版本/图片|与报价来源仍用PR02原预算，不发起额外超支审批|
|11 客户报价及确认|原quotation当前/确认版；原历史页quoteVersion|客户确认版保留原金额口径；负责明细与汇总权限由原接口控制|
|12 开发原单/轮次/打板/杂事|development/rounds；pattern-room related-orders|关联分页继续读；轮次明确，缺轮次资料不强归某轮|
|13 PLT/结构用量/开发基码|technical/history directory→精确artifact版本|整款及本单PO范围分别读取，元数据20+1分页，正文/私有PLT按需；当前采用版独立于最新草稿|
|14 定位图/工艺回样确认|原execution.routeFacts/facts附件及原开发单|原定位/工艺确认事实及照片；不以照片存在推定设计认可|
|15 洗前后尺寸/尾查实测|原execution inspection payload|沿原phase、尺寸列、量法/原附件；不新造独立“样衣表”|
|16 最终评语/尺寸复核|technical comments精确版本+reviews|中间沟通与最终批复区分，沿用/改版结果和原任务可达|
|17 客户尺码模板/跳码|采用技术版baseSizeTable.templateRef→原技术模板精确版本GET及gradingNote|按原技术/Root权限读取采用模板完整原表，不借最新覆盖；不伪称客户真实模板算法已业务验收|
|18 设计交接/投料/对色|source或order readiness.history|节点事实/凭证复用，不各造表、不恢复跟单重复对色分类|
|19 主辅料/款号唛实物|同readiness物料版/数量明细|撤回/无效版标清；保留实物计件与原开裁质量条件|
|20 高温缩率/预缩依据|technical context.materialDecisions+preparation|技术决定、供应商证据及采用版原链；有文件不等于已确认|
|21 船样/快递号|factory-flow.shipSamples专门集合|多PO/历史真实快递；原提醒保留，无全链门禁|
|22 工厂成衣检查|productionInspectionHistory/productionChecks|与裁后checks分开读取；检查分配范围/数量版不和报量混算|
|23 QC返工/本厂做尾|Journey关联→rework-orders/:id/business-detail|沿服务端字段/工资/判责遮罩和私有附件；只读，不复建节点|
|24 PO/客户日期历史|原order.lines+instruction.dateRequests|结构化PO不是上传原件；客户日期历史不改系统计划/实绩|
|25 本期结案依据|原closure.closed及原收尾办理入口|来源链接≠实际结案；未有事实显示待核，不用目录数量判断完成|
|26 已退役工厂收料/清点|factory_history只读旧facts|仅查看全部的历史类，无当前待办/必填/门禁/进度分母|

实现位置：`cockpit-documents-model.ts` 保留旧读者，新增只读分类在 `cockpit-documents-technical.ts` / `cockpit-documents-production.ts`；固定原事件分页在 `order-document-history.ts`。原技术history在原READ ONLY权限事务内增加元数据/精确版读取；沿用技术成果只允许已证明child/source/round继承关系，不授父单全历史权限。没有新增通用事实写入端点、migration、权限授予或后台表。

## 实际验证与边界

- 首轮原准备/技术/收货PG共70项通过，4个本次资源真实清理；范围原凭证上传→绑定→授权下载、跨单/撤权404、21条历史20+1、技术有效版在最新20草稿之外、复版沿用精确版本/原HTTP校验均覆盖。两项新断言最初误期望403，原接口资源隐藏404；仅修期望，未放宽权限。
- 原开发读取PG20项通过。首次17过3失败来自旧短交期夹具仍期望400；相同文件树的原基线最小复现也返回409。只将这三项改为409并核`SHORT_LEAD_APPROVAL_REQUIRED`，未来非法日期仍400，拒绝/草稿保留/修正后成功断言保留。不是本次新放宽日期规则。
- 该旧文件进入本次diff后，预检准确拒绝其原有裸CREATE SCHEMA；已就地换为同一owned schema创建/移交清理API并重跑20项和预检。无新资源前缀、无额外全链或清理放行；失败发生在本地，未推远端试错。
- 144项原目录/快照/新源/原父页SSR/原鉴权/实际返回URL单测通过。原SSR目录标签断言随已批准10类和查看全部更新，原页面区域保留。自查补齐本单PO技术成果/评语的按需入口，父子每层继续携带原scopeRef，不把PO资料归成整款；精确版本、错误范围拒绝及真实页面点击有反例。
- 浏览器实际挂载`DigitalCockpitPage`及原报价历史页，10场景×1280/1440：十类/原外壳/原计划草稿未丢、长名、限定并发3、分页、无权、读取失败恢复、身份改变缓存清空、真实历史页返回恢复筛选/展开/滚动/焦点、切单、键盘。模拟TEST接口明确标记，不是现场登录、真实单据下载或业务验收。截图与结果保留在运行记录定位；不把模拟通过扩大成全部后端来源实测。
- 浏览器先后暴露源链接被误算“有记录”、原生dialog快速重开被旧close事件关闭，均在生产组件修正并有反例；来源链接现在`sourceOnly`，关联收货批次也不冒充已实收或已装箱；读失败≠缺资料。没有提高超时或删交互断言。
- 无新数据迁移。只新增原域受权只读分页/精确版，保留原写入、下载、计划时钟和下游数量/质量职责；不进入PR08材料一览。

## 组装、审查与回退

本次风险FULL（跨域受权元数据/私有附件引用）；冻结后一次Codex Review及必要最终Gate，绑定实际head/base。只读视图回退可恢复原目录实现；历史事实和附件无写入，不需要删表或回滚业务数据。保留原失败日志、基线复现和未现场验证范围，不将定向结果称最终Gate通过。

## 一轮Review集中修复

审核基于 b2ba335f，两个P2：大货技术链接改用原制单adoptedRound（明确null不借最新开发轮），以及已展开的资料写入同身份/同快照可搜索树。补“开发3轮但制单采用1轮/准备失效仍有历史范围/无采用轮不伪链接”、懒加载明细及备注搜索/实际PLT文件名搜索反例。PO范围与来源链接精度自查同批收口。未重新请求Review，修复head不冒称已被重审；最终Gate待准确新head执行。

父级三项定点同批补正：物料entry身份含recordId和version（同recordId原凭证不丢）；原模板版本化只读端点沿现technical角色鉴权（设计/QC不因此新增模板权限）；重开目录即以本次核验会话重建原来源快照，隐藏旧会话元数据至新来源授权完成。反例为同recordId v1/v2、模板T v1采用后更新v2仍读v1、同actor同roles仅订单scope被撤后重开，均不以不同ID或换账号替代。没有新迁移/授予，原模板最新列表/维护/开发发布消费者保留。

最终三项补正后，原准备/技术/收货/开发四文件合计91项PG通过并完成精确资源清理；144项定向单测、20个真实父页TEST浏览器场景以及lint/types/preflight通过，绑定当前输入。模板原维护/最新列表未改、原角色能力及迁移/manifest未改，无需伪造新的历史权限差异。目录重开会重新读取原来源鉴权，这是同账号scope撤销所必需；读取失败重试仅重试失败来源，原父页/计划草稿不重挂。浏览器失败注入调整为首次和重开各拒一次，明确在重新授权之后再验证失败重试；不是削弱恢复断言。

搜索回填的旧loader补正：成功Entry统一清除自身load，不再把旧 {...entry} 加载描述符发布回受控effect；子项自身按需load保留。新增实际父页打开制单/预算已发布v1、等待DOM稳定且无重复渲染，再按已载入原图/预算图片搜索，非仅模型返回值。旧Full41371913393在发现此回归后请求取消，不再用于合并核准；CLI取消命令实际exit0，最终取消状态另核。此前连接器无取消方法，原CLI认证探测401不代表这个动作不可用，不再将两者混淆。只复验受影响UI组合，91项API/数据库输入未变，不重跑。
