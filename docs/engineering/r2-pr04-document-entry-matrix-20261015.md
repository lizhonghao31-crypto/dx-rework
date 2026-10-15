# R2-PR04 本单资料入口收归（本地实现与验证）

预检：lizhonghao31-crypto/dx-rework；用户指定集成分支 release/digital-production-v1；基线 da5bb8a1683c1967609ee33c37e162404c246b4a（PR771）；工作分支 feat/r2-pr04-document-container；Full Gate。范围仅 V2.0 第5节及 PR04。允许单据/附件容器、必要原服务适配、对应测试与工程记录。禁止部署、ECS、真实数据、分享和 PR05 工序重构。

本文件记录本地实现，GitHub Gate / Review / merge 另以最终 Head 为准。旧 URL 保持现有解析器与返回白名单，不能把历史版本解析成当前可编辑草稿。

|入口ID|页面/组件|角色/状态|资料类型|查看/上传/修改|原API/数据来源|轮次/版本|新目录位置|旧按钮处理|旧URL处理|测试证据|
|---|---|---|---|---|---|---|---|---|---|---|
|E01|digital-development-create-form|原设计师/Root创建|开发原单及母单|首次创建/上传|sources、development、orders原命令|首次草稿version|源头新建例外|保留唯一母单创建|原创建流程|原接口DB回归 / 路由与残留源码审计|
|E02|digital-designer-workspace editor|原canEdit/canRevise|开发单|读/草稿编辑/复版|sources/:id/development、round-draft、round-publish|round/version|开发单|已改共享容器|保留workspace筛选和round|隔离浏览器与原服务回归（见下）|
|E03|digital-production-page development|原开发技术权限|开发单|读/草稿编辑/复版|同E02|旧round精确传递|开发单|已改共享容器|旧development参数直接适配|隔离浏览器与原服务回归（见下）|
|E04|development-document-fields|原草稿/复版写权限|四类开发图片及PDF|读/上传/移除草稿引用|原upload-intents/finalize/development保存|source/attachmentId/kind|款图与工艺图|同一原编辑器，当前分类直接选择上传|原附件地址保留只读|隔离浏览器与原服务回归（见下）|
|E05|digital-production-page instruction|原订单技术/跟单写权限|大货制单|读/编辑/上传/发布|orders/:id/instruction及原附件服务|instructionVersion|大货制单|已改共享容器|旧instruction/版本参数保持|隔离浏览器与原服务回归（见下）|
|E06|digital-production-page budget|独立预算权限|成本预算|读/编辑/上传/发布/复制草稿|orders/:id/budget及原附件服务|budgetVersion|成本预算表|已改共享容器|旧budget/版本参数保持|隔离浏览器与原服务回归（见下）|
|E07|TaskWorkbenchSample|授权纸样/车板任务|任务采用三单据|默认采用发布版；原权限允许的版本操作|tasks/:id/documents及原reader|task.routeVersion+published版本|前三目录|已复用统一内容组件|task/workbench上下文保持|隔离浏览器与原服务回归（见下）|
|E08|DevelopmentExecutionPanel|ready且canExecute|纸样工艺成果|上传后随complete绑定|execution/upload-intents/finalize/complete|taskId/sourceId|工序成果|已移入共享目录，原提交控制器保留|原任务路由|隔离浏览器与原服务回归（见下）|
|E09|DevelopmentExecutionPanel面料报告|原canReportFabric|检测报告|上传/报告事实保存|execution/fabric-reports，purpose面料报告|source/attachment/fact|面辅料与检测报告|已移入共享目录，原提交控制器保留|原任务入口|隔离浏览器与原服务回归（见下）|
|E10|DevelopmentExecutionPanel面料决定|原canDecideFabric|总监实际决定|审批业务动作|execution/fabric-decisions|reportId|当前办理保留|不迁移审批为上传|原任务入口|原接口DB回归 / 路由与残留源码审计|
|E11|DevelopmentExecutionPanel历史|原技术可见|已提交成果/报告|只读|execution facts及原附件授权|taskId/factId/attachmentId|原证据只读|保留证据链接，非编辑器|原下载链接保留|原接口DB回归 / 路由与残留源码审计|
|E12|DevelopmentExecutionPanel routeFacts|原技术可见/客户确认原角色|确认/寄样记录|事实只读；确认业务动作|route/customer-sample|source/routeVersion/taskId|客户确认与寄样资料|已按原轮次事实聚合；实际确认留办理|原事实ID|原接口DB回归 / 路由与残留源码审计|
|E13|development-order-archive|原档案权限|开发单/历史/附件|查看入口|已有sourceUrl|selectedRound|开发单|链接落共享容器|原workspace/round保持|原接口DB回归 / 路由与残留源码审计|
|E14|digital-journey-cockpit-model|原座舱可见|相关单据|查看入口|已有实体href|原source/order/版本|对应前三目录|路由层统一|原返回过滤参数保持|原接口DB回归 / 路由与残留源码审计|
|E15|bulk-preparation-panel|原产前技术权限|本轮制单|只读链接|instruction|instructionVersion|大货制单|路由层统一|保留指定版本|原接口DB回归 / 路由与残留源码审计|
|E16|外发合同/裁床关联入口|原合同/裁床独立权限|合同/实裁|原证据查看及不可拆分业务办理|原sourcing/cutting服务|真实case/order/lineId|其他关联单据|原授权证据链接保留；合同/实裁业务动作仍由原单据唯一办理|不伪造新关联|原接口DB回归 / 路由与残留源码审计|
|E17|既有通知/书签|原通知接收人及资源权限|三单据/任务|历史兼容|digitalDetailRoute及原reader|round/instructionVersion/budgetVersion|共享容器对应类别|原URL仅路由适配|拒绝无效重复版本与外域returnTo|原接口DB回归 / 路由与残留源码审计|
|E18|车板成果|原车板执行人|车板成果附件|需求D07|原route新增可选attachmentIds；新用途车板成果绑定原task|必须task+round绑定|工序成果|0244用途+task_id；原route命令绑定，独立于开发图|兼容旧请求，不伪造历史成果|隔离浏览器与原服务回归（见下）|
|E19|factory-flow-panel QC|原canQc/在场/本PO任务ready|QC检查图片|上传后随原qc命令绑定|factory-flow原upload/finalize/qc|原order/line/returnFactId|工序成果|原上传控件portal移入目录，原fieldset禁用条件显式保留|原factoryAction/line保持|类型检查、原业务测试、源码审计；未新增QC浏览器场景|

## 原字段、版本与服务映射
- 开发：DevelopmentDocument 全对象、DevelopmentDocumentFields；轮次由 developmentDocumentRow 解析；原草稿 expectedVersion、复版 expectedDraftVersion/basedOnRound；DevelopmentPrint 全文。
- 制单：InstructionDocument 全对象、原六章节；sourceRound/orderVersion/expectedVersion；原source-review不等于保存；ProductionInstructionPrint 全版本。
- 预算：BudgetDocument 全对象、calculateBudget/budgetDisplayAmount 原公式；expectedVersion、不可变published版本；DigitalBudgetPrint 全文；预算目录鉴权先于内容读取。

## 实现边界与验证证据

- 19项为本轮指定入口及阶段附件入口，不声称整个ERP所有附件模块均被改写。合同/裁床仅聚合真实授权关联证据，原业务审批/实裁操作保留唯一原单据，不复制业务表单、附件或台账。
- 三种单据的直接组件消费点仅剩 `order-document-container.tsx`；设计师旧editor、digital详情旧URL、任务样板均通过它。`rg` 检索的其余结果为组件定义。
- 纸样/车板使用同一个 `DevelopmentResultUpload`；报告使用同一个 `DevelopmentFabricReport`。旧办理页通过 `DocumentEntry` 移动控件，原表单和控制器留存，返回仍保留备注与待提交文件。QC采用同样方式且保留原禁用条件。
- 0244只扩展新车板成果上传用途并附带task_id；原附件下载绑定、任务执行权限、原route事务/幂等和原工资执行流程继续生效。车板附件不追加到开发单document.files；历史报告的技术绑定保留，显示始终依据报告事实/用途。
- 独立目录接口只返回授权ID与可用性，不返回预算内容/金额/附件元数据；预算版本查询仍在预算授权之后。任务目录优先真实采用版本；当前资料与历史选择使用原组件。
- 本地默认2345通过/558条件跳过；三组独立PostgreSQL112通过；P07真实车板链回归通过（成果绑定、重复提交、完工后拒绝）；类型检查、lint、build、迁移清单校验、secret scan通过。
- `tests/acceptance/r2-documents-browser.mjs`：旧URL统一容器、草稿切章节保留、四分类原上传及合法PDF、历史不可原位保存、旧车板目录上传正确task且未提前绑定、回到原表单备注保留、报告建议不代替批准、工人预算直链零内容请求。
- PR03原浏览器覆盖继续运行：三桌面视口、三单据读取、预算全章节打印、任务备注/历史分页、8附件分页、长尺寸表、原纸样完成/下载、三个返回上下文。
- 浏览器使用隔离夹具和本机存储传输，没有真实OSS/员工会话/生产服务；内置Chromium PDF查看器只放行浏览器内部资源，外部网络仍拒绝。原返回目的页的todos/pattern汇总及价格目录在此精简夹具中不完整，相关404/500/403不作为目标页成功证据；本次不宣称线上性能或实体打印版式已验收。
- 回滚为应用入口适配回退；不删除已新增的附件、用途、历史版本或业务事实。部署及必要迁移由用户执行。
