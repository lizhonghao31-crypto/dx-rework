# V2.0 R2-PR09 限定共性审计与收口

## 接手与范围

仓库 lizhonghao31-crypto/dx-rework；main=8c2beb55925c15d93e37e7cfaa42b635426a455b；授权集成release/digital-production-v1，基线44a94c2598e418676b8a5a2db75fbf0f0e7d177b；分支feat/r2-pr09-common-audit。Full Gate，最终Head后至多一次GitHub Codex Review。运行版本未读取，不把仓库版本当生产/Acceptance版本。

原文PR09是8个施工步骤、G01—G08及“业务列表15条”；下列15项是对原要求拆分的审计映射，不新增15个业务需求。没有权限/工资/统计/数据库结构修改。当前API消息只改展示名称，不改事件主键、日期值或业务条件。历史版本/PDF及旧审计文本保留。

## 15项映射

| 项 | 原文 | 代码/页面 | 发现与处理 | 验证/结果层级 |
|---|---|---|---|---|
| 01 | 步骤1/G01 | digital-designer-workspace、development-workspace-query | 已有15条、总数先算后slice，筛选page=1；不改 | 原workspace测试+逐页源码 |
| 02 | 步骤1/G01 | digital-pattern-workspace、bulk-pattern-workspace、pattern-room-orders-page | 开发合计15、大货15、杂事/历史15；全范围计数保留 | PR08原DB/浏览器复跑；misc 31条分页DB |
| 03 | 步骤1/G01/G07 | 外发/收货/返工/工资/样衣/供应商/待办 | 原列表15；后台候选、活动摘要非业务列表不强截 | 下表逐页；默认分页/原业务测试 |
| 04 | 步骤1/G01 | 所有列表筛选/序号/总数 | 未发现20/25业务分页残留；不得把API可配置limit上限当默认 | sourcing-list-pagination、receiving-board-pagination、list-pagination、misc DB |
| 05 | 步骤1/G02 | management-reporting-service/exportData、分析/工资聚合 | 导出原50001探测/超50000拒绝，不受15条分页影响；统计独立 | 既有report/工资测试；不改导出范围 |
| 06 | 步骤2/G08 | 材料表、development-document-fields、instruction/budget/print | 明细及打印未套15，原全对象保存；附件独立分页 | 原文档/尺寸/预算/打印测试与真实浏览器 |
| 07 | 步骤3/G03 | 原生单选、SearchSelect/SearchableSelect | 原生箭头不一致；新增app-shell内单选样式，排除multiple/size/隐藏载体；搜索箭头同形 | 专用浏览器键盘/无结果/禁用候选；无裸全局元素CSS |
| 08 | 步骤4/G04 | native-validation、原表单required/min/max | 已有中文原生原因、聚焦、展开、保留输入；不增加约束 | 控件浏览器空必填/数值及原有条件必填测试 |
| 09 | 步骤4/G04 | validation-language、三单据validation | 数字生产字段回退“填写内容”；补日期/PO行/杂事/附件中文定位 | r2-common-errors、validation-language、doc01—03 |
| 10 | 步骤4/G04 | digital-production-api、pattern-order-client | 网络异常英文、非JSON网关异常、状态默认含糊；分类HTTP与读取失败/写入未知，保留服务业务原因及AbortError | r2-common-errors允许/拒绝/断网；digital-request-reuse |
| 11 | 步骤5/G05 | digital-detail-navigation、DevelopmentWorkspaceReturn、TaskWorkbench、OrderDocumentContainer | PR07/08已唯一来源返回；预览关闭及资料内回办理不是第二页面返回 | 原浏览器座舱/待办/开发/大货来源复跑；历史native原详情 |
| 12 | 步骤6/G06 | PO当前提示/外发创建/合同编辑/日期审批错误 | 当前客户仓同义提示改出货日期；工厂/实际发货、历史版本/PDF原标签保留 | po-date测试、日期审批DB；检索差异核对 |
| 13 | 步骤7/G05 | PR04入口矩阵E01—E19 | 三单据和阶段附件沿同一容器；源头首次创建、原合同/实裁业务办理、历史只读是明确例外 | PR04矩阵逐项复查，真实文档浏览器；QC仅源码+原DB，不宣称新浏览器覆盖 |
| 14 | 步骤8/G04 | 资料目录及额外分类 | 目录失败后额外分类误显示“没有资料”；改保留失败/加载状态，不伪报空 | 真实服务浏览器注入503，成果分类仍为失败且唯一返回 |
| 15 | 步骤8/G08/G07 | 切换/未保存/只读/低视口/长文案 | PR03—08原保护保留；低视口样式已允许自然高度和滚动 | 完整工作台浏览器+真实任务/资料200%低视口；旧模块主操作由原单元/DB Gate，不称全模块人工验收 |

## 逐页面列表审计

路径均位于apps/web/src；API说明为原服务，不新增分页框架。`(p-1)*15`为默认offset；可配置limit按原合同保留。

| 页面 | 前端条数/复位 | API/总数范围 | 结果 |
|---|---|---|---|
| digital-designer-workspace | 15/update page1 | development-workspace-query，全授权筛选total后slice | 已满足 |
| digital-pattern-workspace | 合计15/update page1 | 同上pattern，完整counts再slice；环节查询非当前页过滤 | 已满足 |
| bulk-pattern-workspace | 15/update page1 | bulk-preparation-service，count同where，SQL offset | 已满足 |
| pattern-room-orders-page 杂事/历史 | 默认15/各筛选setPage1 | order-reader，scope+origin+filters同count及limit | 已满足，31条DB |
| digital-production-workspaces 档案 | 15/update page1 | cockpit-query count visible，LIMIT15/OFFSET | 已满足 |
| digital-journey-cockpit/production-command-center | 15/onChange page1 | journey/workspace全范围后分页，不截KPI | 已满足 |
| digital-analysis-page | 15/change page1 | reporting-query分组/汇总与rows分页分离 | 已满足 |
| my-todos-page | 15/查询复位 | todos分页与可见范围，序号按返回pageSize | 已满足 |
| sourcing-workspace-page | 15/筛选复位 | sourcing服务count及totalOrderQuantity全范围，LIMIT15 | 已满足，16条分页单元 |
| production-display-workspace | 15/update page1 | production-dashboard服务原分页/全范围统计 | 已满足 |
| order-board-page 收货 | 15/筛选复位 | receiving-service原count/KPI与页查询分离 | 已满足，分页单元 |
| cutting-page | 15/筛选复位 | cutting-source-service原page/totalCount | 已满足；裁片/码数明细不截 |
| reporting/rework-query-page | 请求limit15/筛选复位 | management-reporting-service原scope与offset/count | 已满足 |
| reporting/workflow-queue-page | LIST_PAGE_SIZE15/筛选复位 | 原状态队列多状态同查询/计数 | 已满足 |
| frontline-task-page/责任/自厂审批/外责队列 | usePaginatedItems15/resetKey | 原授权响应后前端分页，不截服务汇总 | 已满足；未改权限 |
| wages/wage-period-list | 明细/人员15/筛选复位 | 工资原全授权汇总及独立导出，不切工资事实 | 已满足 |
| reporting/report-center-page | UI15 | reportData原读上限100（明示截断），export独立50000上限 | 已满足，保留原限制 |
| sample-workspace-page 历史/列表 | 15/筛选复位 | SAMPLE_PAGE_SIZE15，原totalCount | 已满足 |
| sample-analysis-view | 分组/明细15 | 原groupTotal/totalCount与汇总分离 | 已满足 |
| supplier-center-page/onboarding | usePaginatedItems15/resetKey | 原授权候选全集按筛选后分页 | 已满足；不把候选截15 |
| master-data/admin/employee-access/workforce | 共享ListPagination15 | 原管理数据范围不改变 | 已满足；无管理写入 |
| 材料/尺码/条款/附件/PDF | 不适用业务列表15 | 全对象保存/原附件独立分页/全文打印 | 明确不适用 |

## 入口及状态审查

PR04入口E01首次创建保留唯一源头；E02—E07开发/制单/预算/任务均落OrderDocumentContainer；E08/E09/E18成果和面料报告在资料区，办理仅引用；E10实际决定及E12客户确认仍是原业务动作；E11历史证据只读；E13档案/E14座舱/E15产前/E17通知书签保留精确来源版本；E16外发合同/实裁为独立原领域，不复制第二编辑器；E19QC原portal及权限条件保留。无新增第二资料库或上传流程。不能据此宣称整个ERP所有附件统一为同一种业务表单。

设计师、开发/大货、档案、座舱、资料读取失败有独立error且不显示0；杂事报价已有loading/error/未配置分态。此次修复资料额外分类失败误空。未保存保护由原DocumentGuard、internal-navigation及任务控制器保留。只读按原canEdit/canExecute/预算独立权限，不用CSS替代鉴权。

## 验证与未测边界

验证日志/tmp/r2-pr09-*，本机证据/workspace/r2-pr09-evidence。默认2369项通过/562条件跳过；随后增加畸形成功响应测试，最终错误/缓存定向18项通过；初轮定向42项。日期与杂事DB40、收货DB36、现行业务链/工资权限/结算DB59，共135项通过。真实工作台浏览器46项、控件浏览器4项，errors=[]；200%低视口原工具栏按钮trial click通过（只检验可点击，不触发打印或业务写入）。最终类型/lint/build/migration/secret/diff通过。无生产或Acceptance运行态读取/写入，无OSS/钉钉操作；未执行全系统每张表单每一种失败的人工矩阵，旧模块采用原测试/源码审计，具体组合仍需父窗口E01—E16综合验收。低视口/200%通过不等于全部移动端验收；本轮不新增业务规则。

旧夹具限制：额外尝试management-reporting-postgres及wage-workflow-postgres，两套旧夹具初始化分别断言末迁移0053、缺temporary_code而失败，未执行的7项不计通过；不为本轮扩改历史夹具。替代使用现行full-business-chain-postgres、finance-wage-access-postgres、wage-settlement-postgres，59项通过；相关原报表/工资主操作仍需综合验收。

## 唯一Review修复

GitHub Review指出杂事成功响应schema异常时读写提示未区分（P2）。按实际method区分：GET提示返回格式异常；POST/DELETE等明确结果未确认，先核对原记录避免重复提交。新增三种method回归；保留原状态/权限原因，不改变业务命令、重试key或输入。最终Head重新跑Full Gate，不重复Review。
