# UI 页面／组件匹配清单（UX-01 前置）

代码基线：main `bbbb56df1db5ee7d18144bb2d7f598f6b86fb4d8`。来源：`apps/web/src/App.tsx` 全部分派分支及其模块入口、`packages/ui/src/index.tsx`、公共 Shell。此清单是源码覆盖映射，不是全系统浏览器验收报告。

现有公共基础：Button、StatusBadge、NavigationItem、KpiInstrument、InsetField、Surface；应用层已有 Header／Shell、SystemDialog、ListPagination、ImageViewer 等。优先适配已有能力，不按文档别名另建重复组件。UX-01 只增加实际使用的提交反馈与校验适配，不新增 runtime 依赖或全局 token。

| 当前入口／页面 | 类型与岗位 | 现有公共／私有实现 | 计划 DX 能力；源码来源 | PC／手机与性能风险 | 归属 |
| --- | --- | --- | --- | --- | --- |
| `/`、`/ui/home` | 公共入口；按账号授权 | HomeLanding、Shell | 导航／公共状态；现有实现 | 两端授权入口一致；避免重复会话读取 | UI-03C3 |
| `/auth/login`、`/auth/denied`、`/auth/qr`、`/auth/qr/relay` | 登录／拒绝；全员 | AuthGate／LoginPage 等 | 公共字段／错误；现有实现 | 手机容器与跳转；不改扫码协议 | UI-03C3 |
| `/ui/sourcing`、`/ui/sourcing/pending`、`/ui/sourcing/history` | 外发列表；按角色 | Surface、StatusBadge、ListPagination；私有筛选／卡片 | Filter、List、Pagination；无需外部源码 | PC 多款摘要、手机长名称；分页／搜索读取 | UI-01 |
| `/ui/sourcing/create` | 跟单创建 | Surface、私有款色／照片／草稿；SystemDialog | ValidationSummary、FieldMessage，后续 KeyFacts／ImageStrip；自有实现 | 两端缺项定位／上传；不新增长存敏感草稿 | UX-01→UI-01 |
| `/ui/sourcing/orders/:id`：IE、生产管理 | 办理 | 私有逐款价格／工艺表；共享数字工具 | 提交反馈、ResponsiveFactsTable、ActionBar；自有实现 | 手机键盘、逐行金额；幂等与旧响应 | UX-01→UI-01 |
| 同详情：老板／财务／转厂／合同／历史 | 审批专版＋管理 | Workflow、ImageViewer、私有历史／补资料 | KeyFacts、Disclosure、WorkflowRail、Dialog；按需 | 老板工厂第一；受权金额、图片和合同；不整页横滑 | UI-01，UX-02 核销其余提交 |
| `/ui/tasks`、`/ui/tasks/:id` | 返工列表／详情；本人和管理 | ReworkQueryPage、BasicReworkBoard、ReworkDetailPage；私有任务／流程 | 一线模板、ImageStrip、Disclosure、ActionBar；现有实现 | PC 工序→工人；手机折叠；大单 DOM／图片 | UI-02A |
| `/ui/tasks?view=sandbox` | 已上线返工沙盘；获权管理 | ReworkDataSandboxPage、分析筛选／图表 | 分析模板、Filter、KpiValue；先静态数值 | 期间／原单下钻、图表驻留；不新增指标 | UI-02A／原 DS 流 |
| `/ui/qc/new?receivingBatchId=…` | 回货关联发起返工 | ReworkInitiationV2Form、原关联入口保护 | Field、ImageStrip、提交反馈；现有实现 | 手机上传／缺资料；不可绕过入口关联 | UI-02A |
| `/ui/process-configuration`，有／无 `rework` 参数 | 工序办理／队列；IE／管理 | ProcessConfigurationForm、WorkflowQueuePage | Field、任务模板、Disclosure；现有实现 | PC 多工序、手机逐项；不扩大读取 | UI-02A |
| `/ui/work-reporting`、`/ui/piecework/collective`，有／无 `rework` | 报工／办理队列 | WorkReportingForm、WorkflowQueuePage | 数量输入、ActionBar、Dialog；现有实现 | 软键盘／重复提交／多人任务 | UI-02A |
| `/ui/frontline`、`/ui/frontline/tasks` | 一线入口／本人任务 | FrontlineLandingPage、FrontlineTaskPage | List、Status、任务模板；现有实现 | 大按钮／清晰当前任务；只加载可见任务 | UI-02A＋UI-03C2 |
| `/ui/supervisor` | 管理摘要 | ManagementDashboardPage | 管理模板、KeyFacts、Disclosure；现有实现 | 管理范围／摘要去噪；查询量 | UI-02A |
| `/ui/responsibility`、`/ui/own-factory-approvals`、`/ui/external-responsibilities` | 责任队列／审批 | 独立队列与责任组件 | 管理模板、Dialog、Table；现有实现 | 责任与扣款语义保留；复杂树与批量办理 | UI-02A |
| `/ui/pattern-room`、`/ui/pattern-room/orders`、`/ui/pattern-room/orders/:id` | 板房看板／任务／详情 | PatternRoomPage、PatternRoomOrdersPage／DetailPage、Shell | 一线／管理模板、ImageStrip、WorkflowRail；自有 | 师傅本人当前任务；多轮／图片／历史 | UI-02B |
| `/ui/pattern-room/create`、`/ui/pattern-room/prices` | 创建／价格管理 | PatternOrderCreatePage、PatternRoomPricesPage | Field、Table、Dialog；现有实现 | 手机材料上传、价格范围；不改计薪 | UI-02B |
| `/ui/receiving`、`/ui/orders` | 仓管录数／跟单差异 | ReceivingPage、OrderBoardPage；私有数量／差异 | 一线＋管理、KeyFacts、Table、Filter；自有 | 原筛选和四数字位置不变；数量联动 | UI-03A1 |
| `/ui/cutting`、`/ui/cutting/orders/:id` | 裁床实裁 | CuttingListPage、CuttingDetailPage、Shell | 数量 Field、KeyFacts、ActionBar；现有实现 | 手机填写／返回；不重复累计 | UI-03A2 |
| `/ui/production-dashboard`、`/ui/production-dashboard/:id` | 实时看板／详情 | ProductionDashboardPage、Surface、StatusBadge；事件带／进度条 | KeyFacts、List、Filter；保留自有持续动效 | 前台可见持续动画，与鼠标无关；后台停；不新增数据轮询 | UI-03A3 |
| `/ui/production-reporting`、`/ui/production-reporting/:id` | 生产填报／修正 | ProductionReportingPage；私有表单 | Field、ActionBar、Dialog；现有实现 | 手机数量、历史修正；保留权限 | UI-03A3 |
| `/ui/suppliers`、`/ui/suppliers/manage` | 目录／正式维护 | SupplierDirectoryPage、SupplierMaintenancePage；私有表单／批量面板 | Nav、Filter、Table、BottomSheet；先借交互 | PC 列表、手机筛选；批量与敏感资料 | UI-03B1 |
| `/ui/suppliers/requests`、`/ui/suppliers/requests/new`、`/ui/suppliers/requests/:id` | 申请／审批 | SupplierOnboardingPage | 管理模板、ValidationSummary、Dialog；现有实现 | 撤权与重放；不重复生成供应商 | UI-03B1 |
| `/ui/samples`、`/ui/samples/pending`、`/ui/samples/disposed`、`/ui/samples/amounts`、`/ui/samples/:id` | 图库／管理／金额视图 | SampleWorkspacePage；私有图库／筛选 | Gallery、Filter、BottomSheet、Status；先自有 | 保留图库；图片解码、批量数量、字段授权 | UI-03B2 |
| `/ui/samples/create`、`/ui/samples/batch-create`、`/ui/samples/handoff` | 创建／批量／交接 | SampleCreatePage、SampleHandoffPage | Field、Gallery、Dialog；现有实现 | 手机上传／交接；资源上限不放宽 | UI-03B2 |
| `/ui/finance`、`/ui/wages`、`/ui/wages/*` | 工资／财务 | WagePage、Shell；现有查询／导出 | Table、Filter、Pagination；现有实现 | 手机局部横滑；金额不动画，不全量预读 | UI-03C1 |
| `/ui/my-tasks`、`/ui/my-tasks/*` | 待办／责任任务 | MyTodosPage、ResponsibilityTaskPage、ListPagination | TodoIndicator、Search、List；自有 | 红点／返回上下文；共享 timer 不复制 | UI-03C2 |
| `/ui/admin`、`/ui/audit`，attachments／delegations／exceptions 等 tab | 平台管理 | AdminConsolePage、Shell、现有页签 | NavRail、Table、Dialog；先借交互 | 高权操作／密集列表；不改管理授权 | UI-03C3 |
| `/ui/employee-access`、`/ui/people` | 员工权限／人员主档 | EmployeeAccessPage、WorkforceMasterDataPage | Filter、Table、Field；现有实现 | 兼岗与筛选；请求／分页 | UI-03C3 |
| `/ui/master-data`，processes／crafts／suppliers 查询模式 | 工序／工艺／供应商旧入口 | MasterDataPage、LegacySupplierCenterRedirect | Nav、Table、Dialog；现有实现 | 保留重定向／批量职责；不造第二套资料维护 | UI-03C3 |
| `/ui/reports` | 报表中心 | ReportCenterPage、业务分析组件 | 分析模板、Filter、Table；按需 | 先授权后聚合、下钻上下文；昂贵读取 | UI-03C1／UI-04 |
| `/system/foundation`、未知路径回首页、加载／拒绝态 | 公共状态／基础页 | Foundation、AuthGate、PlatformEntryChecking | Loading／Empty／Error；现有实现 | PC／手机不溢出，入口守卫不变 | UI-03C3／UX-02 |

## 开源与公共组件边界

UX-01 未复制外部组件源码，provenance 不适用；未新增运行时依赖。后续 BottomSheet／导航若借鉴，仅按实际组件核验来源、commit、许可证。现有 SystemDialog 不在此 PR 重写；提交摘要暂置于应用层，待 UI-01 有真实样板后再决定哪些纯展示能力下沉 `packages/ui`。

## 覆盖与遗留

- 已完成路由分派清点，含动态详情、查询模式、别名、重定向、公共认证与内部沙盘入口；未做每个岗位的浏览器全流程验收。
- UX-01 只接创建、IE 报价、生产管理选厂和创建页上传失败。老板、转厂、合同、财务与补款号旧提交路径留给对应 UI 迁移／UX-02，不宣称全外发反馈已统一。
- 后续每行补 PC／手机截图、岗位结果、错误状态和性能数据后才标记完成，不以“使用共享组件”替代验收。
