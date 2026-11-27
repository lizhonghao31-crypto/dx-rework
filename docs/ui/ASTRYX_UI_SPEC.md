# 达兴 Astryx UI 规范

版本：1.0（2026-11-21 批准）\
适用：达兴前端新增、维护、迁移和验收；以目标分支纳入本文件的提交为生效点。\
官方基线：`@astryxdesign/core@0.7.16`，[官方发布](https://github.com/meta/astryx/releases/tag/v0.7.16)，源码提交 `5051ea96a35307183e9f3fab7fadcc7b0d649e45`。\
本规范不修改业务、权限、校验、数量、时间、数据来源、接口或现有部署。文档就绪和代码已迁移是两个状态。

## 0. 每次改 UI 先做这七件事

1. 从目标分支的 [AGENTS.md](../../AGENTS.md) 进入本规范；读任务对应的页面契约、组件目录和业务依据。先定位实际入口、原动作、当前基线和用户已批准的变更范围。
2. 判定工作类别：**新增页面 / 旧页日常修改 / 明确安排的迁移**。新增页面只走中央 Astryx 入口；日常修改只改授权影响范围，不捆绑迁移；迁移单独审批和验收，样式仅在指定范围启用。迁移前后不得因组件更换擅自调整字段、排版分区、入口、权限或计算。
3. 使用规则 ID 选唯一默认：官方原件 O → 已登记组合 C → 批准的中央扩展 E。不能新加第二 UI 库、随手定新色值和尺寸、改内部私有样式，或借缺口改变用户路径。已有合法的原生 HTML / 平台能力不构成第二个 UI 底座。
4. 如果默认方案处理不了，先保已有行为、列明缺口和建议，仅暂停受影响的新 UI 决策，其他工作继续；新页面不得以 legacy 或自造样式填空。不能自行批准例外。
5. 核对可见性与操作：字段和值、主要和次要动作、空/错/无权/未知、预览下载、返回和焦点、键盘与输入法、长中文及窄屏都按相同业务场景比较。
6. 提交说明须列规则编号、适用路由和证据。新增基础件或兼容例外必须登记；无证据不标已迁移。不是新增的 UI 缺口不要扩写为全局规则。
7. 先走现有静态检查及影响范围内的真实浏览器验收；纯文档只检查链接、规则 ID 和旧入口归属，不重跑数据库全量。规则中的自动检查是接入要求，不表示当前已经部署门禁。

## 1. 唯一事实来源与证据

本文件是唯一规范正文。页面契约绑定路由、角色、字段、动作及规则 ID；组件目录记官方来源、版本、实际接口与选型；用例记输入与预期；检查表执行规则。配套文件不得另立标准。规则 ID 为稳定标识；同一 ID 的其他出现只作引用或验收映射。旧文中已迁视觉规则不再并列行权，业务契约和历史证据保留。

证据分层：**U** 用户批准、**R** 固定代码及合并记录、**O** 官方固定版本、**H** 历史稿、**V** 运行实证、**P** 映射候选。正式批准的业务和页面结构优先于组件默认；当前代码只证明已实现，不会反向授权变更。无 V 不冒充已验收。

范围基线：核证工程样本为发布分支 `1d163c5e`（含 #1073）和主分支 `b3113e5c`；施工重新锁实际目标分支，不当成永久 HEAD。发布分支的座舱有局部 Astryx 试点，主分支基线未引入；两者均不是全站迁移完成。

## 2. 页面模板和组件登记

主规范负责规则；仓库未来的 `docs/ui/catalog/`、`docs/ui/pages/`、`docs/ui/cases/`、`docs/ui/checks/`、`docs/ui/evidence/`、`docs/ui/migration/` 仅承载目录、实际适用范围和证据，不复制规则正文。建议业务页通过独立中央子出口接入，不直接替换现有 UI 根出口。文件、目录和出口在所在分支实现前不得假设已存在。

## 3. 全站实际页面族与迁移落点

真实入口由 App.tsx 条件路由与 platform-modules.ts 权限共同决定。文件存在不等于用户可达。清单必须覆盖 query workspace、角色只读分支、弹层、历史、打印与诊断入口。[D-app][D-modules]

| 页面族 | 已核实际路径/路由 | 模板与首选 Astryx 组合 | 特别保护 |
|---|---|---|---|
| 认证/根入口/外壳 | /、/auth/login、/auth/qr、/auth/qr/relay、/auth/denied、/ui/home；main.tsx、App.tsx、login-landing.tsx | AppShell/导航 + Layout + Text/Input/Button/Banner；保 SDK 宿主 | 登录与 return、身份检查、备案、首帧样式 ready |
| 管理座舱 | /ui/digital-cockpit；digital-journey-cockpit.tsx、cockpit-home.tsx、cockpit-detail.tsx | 筛选列表 + 复杂详情；Table、统一双轨、真实节点、Dialog | 本文两套完整样章 |
| 座舱设置/交付日历 | workspace=settings/delivery；cockpit-production-settings.tsx、sla-history-workspace.tsx、delivery-calendar-page.tsx | 设置/历史/日历；FormLayout、Table、Collapsible、Grid | 演算/预览/应用不混淆，历史版本上界 |
| 数字开发/大货/设计师 | /ui/digital-production、workspace=designer；digital-production-page.tsx、digital-designer-workspace.tsx | 长单据/办理/工作台；Layout、Field/Input/Table/上传组合 | order/source/task/round身份、草稿、原办理入口 |
| 板房/技术 | /ui/digital-pattern-room；/ui/pattern-room 下orders/create/prices/history与详情；digital-pattern-workspace.tsx | 看板、列表、详情、价格/指派；Grid/ScrollableArea/Table | 原阶段/轮次/价格权；窄桌面局部横滚 |
| 实时生产/填报 | /ui/production-dashboard、/:id、workspace=display、motherOrderId；/ui/production-reporting | 数据看板、记录详情/填报；Table、原业务图形组合、FormLayout | 数量与时间分母不混合，本单定位、原工厂权限 |
| 待办/一线 | /ui/my-tasks、/ui/frontline、/ui/frontline/tasks；my-todos-page.tsx、responsibility-task-page.tsx | 筛选列表 + 原办理面板 | 先资格过滤、真实返回、竞态与权限 |
| 回货/收货 | /ui/orders、/ui/receiving；order-board-page.tsx、receiving-page.tsx | 列表/差异/装箱/更正小窗；Table、Dialog、上传组合 | 数量、更正、未收与超收、幂等、凭证 |
| 外发/供应链 | /ui/sourcing 下pending/create/history/orders/:id；sourcing-workspace-page.tsx等 | 多款长单据/审批/历史 | 价格预算裁剪、选厂、合同、原写入链 |
| 返工/责任链 | /ui/tasks、/ui/qc/new、/ui/process-configuration、/ui/work-reporting、/ui/piecework/collective；rework-detail-page.tsx等 | N01–N10业务详情、创建/配置/计件 | 返工只能从原回货批次入口创建；不是座舱详情布局 |
| 审批/责任队列 | /ui/responsibility、/ui/own-factory-approvals、/ui/external-responsibilities | 资格筛选列表 + 岗位办理 | 原责任人、拒绝路径、total与目标页同集合 |
| 订单开裁 | /ui/cutting、/ui/cutting/orders/:id；cutting-page.tsx | 列表、数量矩阵、详情、修订历史 | 原财务只读方案与样衣财务排除不被UI迁移改变 |
| 样衣 | /ui/samples 下详情/create/batch-create/handoff/pending/disposed/amounts | 清单、批量表单、交接、金额/历史 | 借出/归还/处置/赔付/归档不能统一改成“完成” |
| 供应商/资料 | /ui/suppliers 下manage/requests等；/ui/auxiliary-catalog、/ui/master-data、/ui/people | 主从目录、申请、维护、导入 | 已有ID选择与自由输入分离，读/维护权分离 |
| 工资/财务 | /ui/finance、/ui/wages、/ui/wages/:id；wages/wage-page.tsx | 期间列表、明细、分析与导出 | 当前路由由WagePage承载；金额精度/全量合法导出 |
| 分析/报表 | /ui/digital-analysis、/ui/reports、/ui/supervisor | KPI + 授权全范围聚合 + 依据下钻 | KPI不是当前页求和；原口径/时间分母/未知 |
| 系统管理 | /ui/admin、/ui/audit、tab=attachments/delegations/exceptions、/ui/employee-access、/ui/contract-template | 管理列表、权限表、合同条款编辑 | 原角色能力、审计、合同内容完整 |
| Acceptance诊断入口 | main.tsx 分派的Lab/指挥台 | 独立工具模板、可登记边界 | 不代替真实业务验收，不推广诊断行为到业务 |

**拟注册十二类模板：** 认证/外壳、筛选列表、主从目录、看板、业务详情、长单据编辑、任务办理、只读历史、设置/演算、分析/报表、日历、局部小窗。

模板只规定 UI 构件和可重复行为，不规定所有模块都八列、同一行高、相同字段或同样折叠。新页按业务类型唯一选模板；跨类型页面使用注册的组合，不靠作者重新布局。

### 3.1 十二类模板的唯一默认选型

下表为P类方案。**既有页面先匹配其已登记页面契约；不得因模板名称相近而改变原区域、原入口或原默认展开。** 下表的默认骨架用于新页面，以及已证明与原结构等价的旧页面承载替换。

| 模板ID/名称 | 触发条件 | 唯一默认骨架/选择规则 | 不允许自动做的事 |
|---|---|---|---|
| T01 认证与应用壳 | 建立身份、展示身份拒绝、顶层模块导航 | AppShell/既定导航组合＋Layout；认证输入用原生form＋FormLayout＋输入/Button；保二维码SDK宿主 | 生成新权限菜单、改变登录return、把拒绝当空数据 |
| T02 筛选列表 | 同类业务对象需要按共同字段跨行比较、搜索、翻页 | 原字段形成Table columns；顶部统一筛选组合；底部统一分页外观，按 DXUI-PAGE-005 保留原跳页、逐页或追加续读能力；行内原动作 | 列表直接换卡片、在页内排序假装全局、隐藏原动作或加原来没有的分页控件 |
| T03 主从目录 | 用户必须连续选择目录/实体并同时查看该对象的局部信息 | 官方Grid/Layout保持目录与详情两个区域；目录List/Table依是否需要跨列比较；详情用事实组合 | 把必须同时看的两区拆成两次路由、把身份文字当ID |
| T04 阶段看板 | 首要任务是按原业务阶段分组观察，而非线性向导 | Grid/ScrollableArea＋Section/Card；阶段与卡片来自原业务投影；动作仍是原命令 | 默认增加拖拽、按列位置推状态、减少阶段以适应屏幕 |
| T05 业务详情 | 查看单一业务对象的身份、事实、关系、原动作和审计 | Layout/Section＋MetadataList/Text＋必要Table/List；按已批准分区承载；资料/历史维持原读取策略 | 把所有详情套座舱列比、把完整事实折进新Tab |
| T06 长单据编辑 | 单个可保存文档包含多个区段、重复明细或数量/金额矩阵 | 原生form＋FormLayout；新页默认vertical，重复明细用Table＋官方输入；保原章序/加行/草稿/提交 | 自动简化字段、NumberInput改金额、把保存改成即时写入 |
| T07 任务办理 | 用户以明确task/instance身份完成原业务动作 | Layout＋原任务事实＋必要FormLayout＋原办理Button；历史独立区 | 把“查看”改成“办理”、多实例按同名合并、后台写入由UI新造 |
| T08 只读历史 | 阅读版本、事件、变更前后事实，不能写当前状态 | Table/List＋原版本/游标控制；详情用事实组，原查看入口保留 | 混入当前版本事实、追加记录后静默重漏、把历史改为表单 |
| T09 设置与演算 | 维护配置，或预览/演算后再明确应用 | FormLayout＋结果Banner/Table；预览、保存、应用保独立原动作；Switch只适用于原即时布尔项 | 预览即应用、开关隐式保存有审批的参数、UI改SLA |
| T10 分析与报表 | 首要目标是比较完整授权业务集合的指标与依据 | Card/Text＋Table；已有图形保真实口径；下钻复用原查询；确需图表按外围能力准入 | 以本页求全局KPI、拿0替未知、图形轴或颜色改业务含义 |
| T11 日历 | 以日期选取或按日期定位业务事项 | 仅选日期用Calendar/DateInput；承载交付事项用统一Grid/Section＋原事项模型 | 把Calendar当现成排程、拖动即改交期、合并多PO日期 |
| T12 局部小窗 | 保持列表上下文查看同一对象的自足局部信息/确认 | 新只读信息默认Dialog purpose=info；原持续并行侧边工作区用Drawer；短锚定说明用Popover；现有入口仍按已批准模式 | 将收货小窗改风险页、旧原位筛选改弹窗、为组件高度删历史 |

组合的判断也固定：

- 同页“列表＋打开一单收货窗”是T02＋T12，不新创一类页面。
- “目录项很多”不自动代表Table；只有需要按多列比较时才用Table，否则List。是否需要比较由业务任务/现有契约确定，不能由作者审美决定。
- 官方Stepper只准用于真实的单次线性输入向导；审批/生产/多轮任务状态由领域模型决定，统一真实节点组合承载。
- 无法归类时进入第12章缺口流程：先说明业务差异与最小反例，不复制新CSS、也不擅自删需求使其勉强归类。
- 每个模板的默认字号、密度、间距与异步分支引用同一规则ID；页面contract只填字段、原动作、适用状态与已批准局部几何。

### 3.2 组件目录与页面契约如何实际绑定

以下名称和结构是拟议登记示例，不声称这些Dx组件已经存在。官方原件不重造另一套props；只有确有业务语义的组合才建立自己的契约。

```yaml
components:
  - id: AX-Pagination-capability-reference
    kind: official
    package: "@astryxdesign/core"
    version: "0.7.16"
    import: "@astryxdesign/core/Pagination"
    export: Pagination
    use: 上游能力记录，不是业务跳页调用入口；业务入口按 DXUI-PAGE-008
    rules: [DXUI-PAGE-001, DXUI-PAGE-004]
    approved_usage:
      variant: input
      page_base: 1
      total_source: same_authorized_eligible_collection
    forbidden: [unknown_total_presented_as_exact, client_fetch_all_for_jump]

  - id: DX-FactPair
    kind: composition
    owner: packages/ui/src/astryx/patterns
    official_parts: [Text, MetadataList, MetadataListItem]
    rules: [DXUI-TXT-002, DXUI-TXT-003, DXUI-TXT-004]
    data_contract: 原标签与已格式化事实；不计算日期/金额/SLA
    forbidden: [page_private_font_size, implicit_new_business_field]

  - id: DX-CockpitDualProgress
    kind: composition
    owner: packages/ui/src/astryx/patterns
    official_parts: [ProgressBar, Grid, Stack, Text]
    rules: [DXUI-HOME-001, DXUI-HOME-002, DXUI-ASYNC-007]
    data_contract: 两条原领域ratio、未知原因、原formatter和可访问名称
    forbidden: [recompute_denominator, unknown_as_zero, text_clipped_by_fill]
```

```yaml
page_id: cockpit-home
baseline_sha: 1d163c5e523b09dc455faece3f089695cf59aa8c
template: T02
rules: [DXUI-HOME-001, DXUI-HOME-002, DXUI-HOME-003, DXUI-HOME-005]
slots:
  delivery_dates:
    source: 原日期投影和CockpitDate格式化
    component: DX-FactPair
  business_progress:
    source: 原visualProgress与useScheduleObservation
    component: DX-CockpitDualProgress
  receiving:
    template: T12
    source: 原receipt-summary接口
    authorization: 原整单查看且具原收货资格
    snapshot: 数量/历史/凭证元数据保持原单次只读一致快照
cases: [HOME-V01, HOME-V02, HOME-V05, HOME-V07, HOME-V10]
```

这些登记项只引用主MD规则。若同字号、日期格式或权限说明发生冲突，修正唯一规则或业务来源的明确条款，并重新验受影响消费者；不能在组件目录另写一个“本页例外”覆盖掉主规范。

## 4. 官方 API 核证与控件选型目录

### 4.1 固定依赖与允许的接入面

- 默认基座为 **@astryxdesign/core@0.7.16**。该版本 peers 为 React/React DOM >=19、@stylexjs/stylex ^0.19.0；具体锁文件沿仓库已验证版本，不能把 peer 范围当自动升级许可。[O-package]
- 官方原件、API 类型、文档和主题必须来自同一固定版本；不能把官网最新页面的示例混到0.7.16。
- 官方原件样式使用发布 CSS；静态达兴主题优先编译为 CSS 与 built theme 对象，避免每次进入业务页临时注入主题。
- 统一采用 **一个达兴中文主题**。使用官方 Theme/defineTheme 的公开能力承载经批准的中文字体、品牌色和密度映射；不同时加载两套主题让页面自选。
- 官方允许 xstyle、className 等样式入口；达兴将其限制在主题、注册组合与模板所有者。业务页不得自由改 Button/Field/Table/Badge 的基础字号、padding、颜色和内部层级。[O-theme][O-styling][O-styling-advanced]
- 不导入 internal 路径、不依赖编译后的短类名、不用 any 强行通过不存在的 props；不把“构建能过”当行为已验证。
- root Theme 会同步 html 的主题属性，影响 portal；不能声称“包了局部 div 就彻底隔离”。过渡机制须在 W1 证明作用域和首帧行为。[O-theme-source]

### 4.2 真实官方名称与纠错表

| 不准猜写的官方名称/参数 | 固定版本真实入口/写法 |
|---|---|
| Box / Modal / Select / Combobox | Stack/Grid/Card；Dialog；Selector/Typeahead等按语义 |
| DatePicker / Upload / Tabs / Accordion / Typography | DateInput；FileInput；TabList/Tab；Collapsible；Text/Heading |
| Descriptions / Alert | MetadataList；Banner或AlertDialog |
| Table rowKey | idKey |
| Stack direction="row"；gap="4" | direction="horizontal"；gap={4} |
| Text variant="body" | type="body" |
| Icon name="search" | icon="search" |
| Toast type="success"或"warning" | Toast只支持info/error；持久成功/警告用Banner对应status |
| useTablePagination({variant:"input"}) | 该插件无input；使用中央严格跳页组合，官方 input 仅作能力参考 |

证据：[O-package][O-table][O-stack][O-text][O-icon][O-toast][O-pagination][O-table-pagination]。

### 4.3 控件清单：原件 O、组合 C、扩展 E

下表中的 C 是本方案的达兴组合建议，不能称为上游现成组件；E 只表示可能需要的统一扩展，未证明必要前不得先实现。

| 能力 | 默认官方原件/明确组合 | 已核关键 API/边界 | 分类 |
|---|---|---|---|
| 应用壳、主导航 | AppShell + TopNav/SideNav/MobileNav，接原模块权限 | 不重新生成业务导航资格；现主路由不因组件替换改变 | O+C |
| 页面分区 | Layout及LayoutHeader/Content/Footer/Panel、Section、Card | Layout有header/content/start/end/footer；简单堆叠用Stack | O |
| 排列 | Stack/HStack/VStack、Grid/GridSpan | Stack direction horizontal/vertical；gap为数字档位；Grid数字列数不会自动响应 | O |
| 正文/标题 | Text、Heading | Text type；Heading level；maxLines=0为不截断；数字可hasTabularNumbers | O |
| 事实对 | MetadataList/MetadataListItem + Text | label/value同一事实字体；中文冒号按统一组合，不加额外字段 | O+C |
| 业务状态 | Badge；长关键状态用StatusDot + Text | Badge非按钮，默认单行省略；已有胶囊外观要经统一主题验证 | O+C |
| 普通/主/危险操作 | Button | label、variant primary/secondary/ghost/destructive、type、isLoading、isDisabled | O |
| 链接 | Link + LinkProvider | href与原路由适配；保return与身份；不能变整页刷新 | O+C |
| 图标操作 | Icon、IconButton | icon；IconButton必需label；不为图标增加第二库 | O |
| 次要菜单 | DropdownMenu/MoreMenu；ContextMenu仅原有场景 | 不能把原直接入口移进菜单增加步数 | O+C |
| 文本输入 | TextInput、TextArea | value/onChange、htmlName、isReadOnly、status；不是仅CSS换皮 | O |
| 事实约束数值 | TextInput + 原精确解析 + FieldStatus | 订单数、金额等拒绝越界且不自动改值的默认组合 | C |
| 范围调节数字 | NumberInput | min/max越界会钳制；isWheelEnabled默认true，达兴关闭；不能直接用于精确金额 | O，有准入条件 |
| 固定单选 | Selector | value:string；options；hasSearch；htmlName；Selector没有hasCreate参数，不得混用其它选择器的创建参数 | O |
| 固定多选 | MultiSelector/CheckboxList | value:string[]；全选范围须由业务定义；选项不可超权 | O+C |
| 远程实体选择 | Typeahead；多选Tokenizer | searchSource是含search/bootstrap等的对象；选中真实对象/ID | O+C |
| 布尔/互斥 | CheckboxInput、RadioList、Switch | CheckboxInput用value；Switch仅用于原本即时保存的布尔项 | O |
| 日期/范围/时间 | DateInput、DateRangeInput、DateTimeInput、TimeInput | 纯日期用ISO日期契约；DateInput清空可能undefined；不可偷偷变UTC日期 | O+C |
| 业务日期显示 | 原formatter + Text；确需Timestamp时显式格式/时区 | Timestamp auto/relative不适用于必须完整年月日的默认事实 | C |
| 表单 | 原生form + FormLayout +官方输入/Field | FormLayout负责布局，不负责提交和业务校验 | O+C |
| 普通数据表 | Table + 明确 columns/idKey + 按原能力选择中央分页组合 | header为ReactNode；renderCell；density/textOverflow；列宽用pixel()/proportional()；原无分页的表不增加控件 | O+C |
| 编辑矩阵/长单据 | Table或官方表格子件 + 输入 + 原文档状态机 | 不把财务/数量模型交给表格插件，不丢加行/草稿/定位 | C |
| 分页 | Astryx 官方案式统一翻页、严格跳页及续读控件的外观 | 原支持跳页才组合 TextInput / FieldStatus；逐页、游标和续读只显示原按钮；未知或旧 total 不参与跳页 | C |
| 搜索/筛选栏 | TextInput + Selector/DateRangeInput + Stack +原控制器 | 不默认引PowerSearch替换现筛选语法；需要复杂表达式才论证 | C |
| 局部筛选面板 | Popover +原筛选字段 | presentation有popover/bottom-sheet/adaptive；不新增保存语义 | O+C |
| 信息小窗 | Dialog + Layout +原内容组件 | isOpen/onOpenChange；purpose info；保焦点与滚动 | O+C |
| 侧边查看 | Drawer | 必需label；side start/end；不是小窗的自动替代品 | O |
| 触屏底部层 | BottomSheet | 有finalFocusRef、purpose、height；按已有交互/明确响应规则选 | O |
| 确认/提示 | AlertDialog；统一SystemDialog适配 | 保原confirm/prompt/alert队列、Promise、取消/空值语义 | O+C |
| 折叠/详情 | Collapsible/CollapsibleGroup | defaultIsOpen/isOpen/onOpenChange；按页面契约显式控制 | O+C |
| 页签 | TabList + Tab | 不将原同屏信息拆成新页签 | O |
| 上传 | FileInput + 原上传协议 +状态组合 | mode input/dropzone、accept、isMultiple、maxSize/maxFiles；选择不等于完成 | O+C |
| 缩略/图像预览 | Thumbnail + Lightbox | Lightbox支持image/video；PDF/Office走原授权查看能力 | O+C |
| 进度 | ProgressBar | value/max、isLabelHidden、hasValueLabel、variant；不承担业务计算 | O |
| 双业务轨与未知 | 两个ProgressBar + Grid/Stack +Text；静态未知分支 | 条内%为DX规则；低比例触屏最小fill必须实测；详见样章 | C；不满足才E |
| 流程节点 | Button/Link + Badge/StatusDot +Text +Stack/Grid +原节点模型 | Stepper只用于真正线性向导，不能代替生产业务状态机 | C |
| 加载/空态 | Spinner、Skeleton、EmptyState | 关键与次要区域独立；空、失败、无权、未知分开 | O+C |
| 持久反馈 | Banner、FieldStatus | Banner可info/warning/error/success；字段错误留在字段处 | O |
| 短暂反馈 | useToast/Toast | 只有info/error；不承载唯一的失败原因和待处理入口 | O+C |
| 日历/目录树 | Calendar、TreeList；交付格以Grid等组合 | Calendar选日期不等于订单排程；不臆造Schedule API | O+C |
| 工具提示 | Tooltip/InfoTip | 仅补充，不作为关键字段唯一完整内容 | O |
| 打印/PDF/SDK | 保原业务能力，外层用Astryx | 属明确平台边界，不冒称官方PDF组件，不带第二UI壳 | C/边界 |

证据来自固定版各组件文档与类型；精确入口见文末 O 类索引。新使用范围必须查相应类型，不能把这张摘要表当完整 TypeScript 签名。

### 4.4 外围能力不能假装是 core

固定源码树里还有 charts、lab、richtext、vega 等包，但它们并非全都与 core 同版本或已经有可安装的稳定版。charts 的固定树 package 为0.1.9，README说明只发布canary；lab为实验能力；richtext需Lexical等peers。**本方案不准业务页自行安装这些包，更不能写 charts@0.7.16。**

真实图表、排程、富文本需求的顺序：

1. 先检查本来是否只需要KPI、Table、Calendar、TextArea等core组合。
2. 确需外围能力，统一核真实发布制品、精确API、peers、中文/键盘、包体积与业务需求。
3. 获批后进入同一组件目录和唯一出口；不能各模块各装。
4. 无可用原件/组合再进入集中扩展流程。

证据：[O-charts][O-package]。不因官方包存在而默认扩大依赖。

## 5. 字体、颜色、间距与内容格式：可验收规则

### 5.1 token的三个层次必须分开

| 层次 | 已核事实或职责 | 使用规则 |
|---|---|---|
| 官方默认 | core body base为0.875rem；sm为0.75rem；lg为1.0625rem；spacing 1/2/3/4为0.25/0.5/0.75/1rem；元素sm/md/lg为28/32/36px | 这是官方源码值，不自动等于达兴最终批准值；不可重置根字号把rem强锁为16px |
| 达兴当前 | tokens.css有13px正文/20px行高、42px输入、手机48px/16px输入、dx-space-4为14px，中文字体栈为Noto Sans SC/PingFang SC/Microsoft YaHei | 不能把同名档位机械替换；旧事实不冒称Astryx标准 |
| 唯一达兴Astryx主题 | 将批准的字体、品牌/语义色、控件密度映射到官方Theme/tokens；保存来源与差异 | 一份完整映射供全体已迁页和新页；不允许按模块再定义一套 |

推荐**保留已批准的达兴中文字体和调色盘，通过官方主题机制承载**。新页默认用Text的body/label语义角色、Table的balanced密度、输入md；实际值以唯一主题版本决定。已有页与此默认存在差异时，必须在迁移前做同屏对照，批准的局部密度可登记明确适用条件，不能临场缩字。

W1必须交付填完整的“官方默认→现有计算样式→推荐映射→批准依据→消费者”表。没有证据的行高、列宽、轨高和断点暂不写成终值；空项应阻止该项验收，不能由AI补一个看起来合适的px。[O-tokens][D-tokens]

### 5.2 字体、间距和格式矩阵

以下默认选择是P类推荐；用户已明确的同字号、完整字段等是U类约束。数值像素不因本表自动覆盖既有定稿。

| 规则 | 默认选法 | 禁止做法 | 例外触发条件 | 正例 / 反例 | 验证与证据 |
|---|---|---|---|---|---|
| DXUI-TYP-001 正文/标题 | 正文Text body；字段标签label；非关键说明supporting；标题Heading按真实层级 | 页面私写小字号、跳标题层级、用Text伪装heading | 已批准紧凑角色进入主题映射，不能只给某页临时缩字 | 同类信息同一角色 / 日期被降为supporting | 计算样式与层级；[O-text]/[O-heading] |
| DXUI-TXT-002 同字号事实对 | 标签、冒号、数字/日期共享同一字号和字体；值可用tabular numbers | 用字号差表达同一事实的标签和值；日期挤小 | 语义确不同且已在页面契约定义，不能把日期当说明 | 预计日期和完整日期同字号 / 只把日期缩成10px | font-size/font-family相等；U+[O-metadata] |
| DXUI-TXT-003 冒号 | 配对事实统一全角冒号；间隔由共享事实组合所有；既有详情局部间距保留 | 批量字符串替换全站冒号；标签自己带冒号又被组件加一次 | 表单独立标签或原批准无冒号标题，不强行添加 | “预计日期 ： 2026-11-21”视觉间隔 / 双冒号或日期贴字 | DOM内容、几何；[D-node-dates] |
| DXUI-TXT-004 日期/时间 | 保留原formatter，完整YYYY-MM-DD；时间/时区/精度按原事实 | 自动relative、只剩月日、日期当UTC瞬间转换、UI重算SLA | 原页面明确仅表达月份/期间时可按其领域格式 | 2026-11-21 / “11-21”冒充完整日期 | 文本+dateTime+边界；[D-date]/[O-timestamp] |
| DXUI-TXT-005 数字/单位 | 原精度/舍入/单位；数字等宽可用hasTabularNumbers；保0与负值 | 空值转0；金额经浮点重算；省略业务单位 | 原批准紧凑显示有直接完整值且不影响决定 | 0件与未知分开 / null显示0件 | 事实对照；[O-text]/[D-domain] |
| DXUI-TXT-006 ±差异 | 原signedValue/unit/kind的格式化结果，保正负号和天数 | 减两个展示日期、去负号、用“+”推断有责 | 明确格式变更单独批准 | +4.48天与“责任待核”并存 / +即“有责逾期” | [D-difference]/[D-framework] |
| DXUI-TXT-007 关键长文本 | Text换行；容器可收缩，必要在原列增高 | nowrap+ellipsis、靠title补全、缩字、删字段 | 文件长名等原有明确截断契约，且键盘/触屏能完整读取 | “计划待核”完整换行 / 45px内省略 | bounds/scrollWidth+人工；[D-home-css]/[O-text]/[O-badge-source] |
| DXUI-SPC-001 间距 | 从官方spacing档位选；新模板默认近邻1、同组2、字段组3、分区4，页面外缘由模板 | 散落8/13/17px“微调”；把dx-space-4直接当官方4 | 批准图几何不能由档位表达，集中登记布局参数 | gap={2} / 每页自写gap:7px | 静态token检查+布局；[O-stack]/[O-tokens] |
| DXUI-SPC-002 密度 | 新数据表balanced；行高随内容；关键字段完整 | compact当缩字修复、定死全站190px或15px轨 | 明确高密度模板且可读性、点击区和字段均通过 | 密集表保字段 / 为行高藏信息 | [O-table]+页面契约 |
| DXUI-THEME-001 主题 | 一个中央中文主题，静态构建CSS；既有品牌值有来源 | 官网当前Figtree/黑色主题截图直接当固定core默认；每页换色 | 品牌正式变更或新增真实语义统一批准 | 同一状态从同token取色 / 每页一组hex | [O-tokens]/[O-theme]/[D-tokens] |
| DXUI-STATE-001 状态色 | 原业务状态映射semantic色，并保文本；完成success、风险warning、错误error等按明确映射表 | 颜色替代文字；用字符串包含“逾”或数字符号自行推责 | 多维状态分别呈现，各有独立文案/tone | 目标延期且无责分别显示 / 全部涂红并写有责 | [D-framework]/[O-badge]/[O-banner] |
| DXUI-STATE-002 长状态 | 短且不裁切用Badge；长关键状态先StatusDot+Text组合 | 将Badge的title当完整可读验收 | 既有胶囊形态必须保留时，用统一主题/组合验证 | 责任待核完整 / 责任…只有鼠标能读 | [O-badge-source]/[O-statusdot] |
| DXUI-STATE-003 文案词表 | 领域枚举→集中显示映射；未知枚举明确待核 | 所有终态改“已完成”；相似文字就去重 | 同实例/范围/事实/状态确等价且已批准 | 借出待确认≠归还待确认 / 两者都“待确认” | [D-samples]+领域映射 |

间距档位是新模板的推荐选择，不是把旧页瞬间按该表重排；迁移必须守其已批准区域结构。页面确需不同密度时定义为同主题下的**有业务条件的模板角色**，不能成为第二调色盘或另一套按钮体系。

## 6. 动作、表单与输入：可验收行为矩阵

| 规则 | 默认选法 | 禁止做法 | 例外触发条件 | 正例 / 反例 | 验证与证据 |
|---|---|---|---|---|---|
| DXUI-ACT-001 动作/导航 | 动作用Button；目标页用Link；进入浮层为按钮语义 | Badge/span冒充可点；href="#"；把站内路由变刷新 | 原链接式按钮外观可用官方Link的动作形式，语义须正确 | 生产入口可Tab/Enter真定位本单 / 蓝字无链接 | [O-button]/[O-link]/[D-fact-links] |
| DXUI-ACT-002 操作层级 | 同一决策区一个主要提交；普通secondary，危险destructive | 全部primary；新增确认/菜单层数；onClick和clickAction重复写入 | 原业务确有多个独立决策区 | 原一击“办理”保留 / 先三点再办理 | 原操作路径+请求；[O-button] |
| DXUI-ACT-003 图标 | 官方Icon与IconButton；动作有具体label | 只有图标无名称、emoji代替状态、引第二图标UI系统 | 业务专属图标统一theme注册 | label“下载凭证” / label“按钮” | 键盘/读屏；[O-icon]/[O-iconbutton] |
| DXUI-ACT-004 无权/禁用/只读 | 后端能力决定入口；readonly保值；disabled说明原因 | 禁用冒充无记录；只在前端藏按钮当鉴权 | 保密资源沿原404/403契约，不额外泄露存在性 | 无权不返回资料 / 用透明CSS藏敏感字段 | 权限拒绝原测试；[D-access] |
| DXUI-FORM-001 字段与提交 | 原生form+FormLayout；保name、required、序列化与原提交器。达兴开发表单必填标 `*`、选填标 `（选填）`，自动生成、只读和展示不标；由原校验和可访问语义决定，不重复显示组件英文提示 | 只换外观丢FormData；UI自行添加必填；默认按钮误提交 | 原即改即存设置保持原模式 | 单次提交到原命令 / 点击取消触发submit | [O-form]/[O-button]/[D-document-editor] |
| DXUI-FORM-002 文本/只读 | TextInput/TextArea；标签持久可见；只读仍可选择复制 | placeholder替代label；disabled代替所有readonly | 密码/保密字段按原规则 | 只读数量可读全 / 一串灰字不可访问 | [O-textinput] |
| DXUI-FORM-003 已有实体 | Selector或Typeahead；值是真实ID/实体，远程查询沿原权限 | 自由文本冒充客户/工厂ID；默认允许创建 | 原业务明确支持建议/创建，保独立入口和权限 | 选到supplierId / 填“某厂”当已选 | [O-selector]/[O-typeahead]/[D-search-select] |
| DXUI-FORM-004 多选/全选 | MultiSelector/CheckboxList；说明当前页或全部匹配 | 全选偷偷包含不可见/不合格对象；筛选后保错对象 | 跨页选择有原业务协议与确认摘要 | 明确“本页15项” / 显示15项却操作全部 | [O-multiselector]+服务端资格 |
| DXUI-FORM-005 精确数值 | TextInput+原解析+FieldStatus为金额/严格数量默认组合 | NumberInput自动钳制改变业务值；浮点误差；空转0 | 原规则允许范围调节才用NumberInput，禁滚轮 | 超额保持输入并报错 / 输入100被改成99后保存 | [O-number]/[O-fieldstatus] |
| DXUI-FORM-006 日期输入 | 官方DateInput/Range/Time，沿原ISO值和业务时区 | locale切换改业务日；自动改期；UI自动补今日 | 明确原默认日期规则 | 日期清空仍空 / 一清空就变今天 | [O-dateinput]+原日期测试 |
| DXUI-FORM-007 校验 | 中文错误落字段，提交错误聚焦原字段；新表单错误展示可统一blur-or-enter | 输入法组合中报错并提交；只Toast错误；改变业务校验条件 | 原实时提示场景保持原触发语义 | 错字段可定位 / 消息一闪后找不到 | [O-form]/[O-textinput]/[D-feedback] |
| DXUI-FORM-008 草稿/并发 | 保原dirty guard、幂等键、版本、提交结果未知恢复 | 对超时直接再写一次；关闭丢草稿；关弹窗当取消成功 | 原明确可撤销命令按原协议 | 查询原提交结果后继续 / 反复点保存产生重复 | [D-domain]/[D-upload-recovery] |
| DXUI-FORM-009 开关 | Switch仅用于真正即时生效布尔设置 | 审批、批量提交、需保存字段擅改为开关 | 原已是即时行为且拒绝时可还原 | 切设置失败还原 / 开关看似成功后台未写 | [O-switch]+原业务 |
| DXUI-FORM-010 长单据/矩阵 | 原章节、锚点、加行、编号、金额和字段定位，官方表格/输入承载 | 通用表单模板删章节；逐行额外请求；失去打印/历史 | 新模板能逐字段等价证明 | 原顺序与错误定位均在 / 为简洁把项藏子页 | [D-document-editor]/[O-table] |

表单中UI的“允许输入”不等于后端业务“允许提交”。两层都需保留，不能以官方组件拥有min/max就删除原服务校验。


开发工作台迁移边界：旧原生规则不得匹配已接入的 Astryx 控件外框和内部
input/select/textarea。共享开发控件标注所有权，直接使用的官方控件以其实际根节点
为边界，作用域只限开发工作台。保留官方单层焦点可见指示与中文提示，不能在全站
补 reset、强行去掉边框/焦点，或把英文元素藏起来。通过原浏览器核对实际样式来源；
未迁旧控件保留，原分页总数、跳页及续读继续按 DXUI-PAGE-005 执行。

## 7. 表格、筛选与全系统分页

### 7.1 可验收矩阵

| 规则 | 默认选法 | 禁止做法 | 例外触发条件 | 正例 / 反例 | 验证与证据 |
|---|---|---|---|---|---|
| DXUI-TABLE-001 表格身份 | Table明确idKey；列来自原字段清单 | 用行索引/款名作为身份；排序后动作串单 | 无ID的数据先由领域提供稳定键，不由UI猜 | 点行打开相同orderId / 翻页后点到另一单 | [O-table]/[D-app] |
| DXUI-TABLE-002 中文表头 | header用Text完整换行；正文textOverflow="wrap" | 猜headerWrap/rowKey/components.HeaderCell；表头省略关键区分字 | 统一主题公开table-header-cell或官方子件支持；只能中央实现 | “客户下单数量”读全 / 列标题只剩“客户…” | [O-table-types]/[O-table-header] |
| DXUI-TABLE-003 宽度/对齐 | 官方pixel()/proportional()；数值列逻辑末端，文本起端；原复杂页按定稿 | 裸猜width数值类型；所有列强制居中；为fit删列 | 业务矩阵/已批准复合单元格有明确契约 | 数量纵向可比 / 金额与日期错列 | [O-table]/[D-document-editor] |
| DXUI-TABLE-004 排序/合计 | 沿服务端完整授权合格集合；保持稳定次键 | 对当前页排序冒充全局；KPI求当前15条 | 原合法有界完整集合已在客户端时可本地 | 总数与KPI全范围一致 / 页码换了KPI跟着15条变 | [D-analysis-gs]/[D-domain] |
| DXUI-TABLE-005 富内容/虚拟化 | 多行富内容优先服务端分页；符合官方条件才启虚拟化 | 强制截断换虚拟化；看到hook就宣称减少DOM | 固定高、flat、唯一idKey且几何/焦点通过 | 座舱15行完整内容 / 1000行虚拟化实际fallback全渲染 | [O-table-base]/[O-table-virtual] |
| DXUI-PAGE-001 分页外观 | 统一居中、密度、按钮高度和长中文呈现；按原能力显示一组现有动作 | 每页私造页码框；只迁共享件漏私有分页；让长中文按钮套数字方块 | 已批准页面专有对齐须登记；没有分页能力的原列表无需控件 | 精确跳页组和追加续读组使用同一外观 / 左右两个重复分页器 | [O-pagination]+U全站分页 |
| DXUI-PAGE-002 数据集合 | 先实际权限和业务资格，再同一集合/同快照total与目标页 | 先LIMIT15再筛资格；先count后另次快照取页 | 单SQL或同连接只读RR均可；客户端只限原完整合法集合 | 前15候选不合格仍取后续合格 / 第一页空但后面有数据 | U-C/[D-todo]/[D-sla-history] |
| DXUI-PAGE-003 查询应用 | 保原明确提交/即时查询语义；改条件重置页；返回恢复已确认查询 | 新控件发第二份请求；清空后旧响应覆盖 | 新页面采用统一控制器，已有页维持已批准节奏 | IME完成后一次查询 / 每个拼音字母都打接口 | [D-live-search]/[O-ime] |
| DXUI-PAGE-004 页码提交 | 只提交合法完整页；失败保已确认页面并提示；取消过期请求 | 编辑半截输入就请求；标签第8页而内容还是第2页无说明 | 原组件有加载占位可明确展示目标页与旧页 | 第8页成功后同步内容/页码 / 超时显示空数据 | [O-pagination]+原请求控制器 |
| DXUI-PAGE-005 分页能力 | 保留原有真实总数、页码和精确跳页及其查询契约；逐页、游标和续读只提供原动作 | 不补造总数、页码、跳页框或按钮，不新增计数、跳页接口、请求参数，不改原历史浏览上界 | 仅统一外观；原无分页的列表保持原样 | SLA历史原跳页和原浏览范围可用；订单单据读第21条保留前20条 / 用假总数或下一页替换续读 | [D-sla-history]+U-C |
| DXUI-PAGE-006 返回 | URL/query/选择/滚动/焦点按原上下文恢复 | 点详情回来重置全部筛选或回第一页 | 原有明确新搜索动作才重置 | 从任务返回原第2页 / 关闭小窗回页首 | [D-record-link]/[D-pr1073] |
| DXUI-PAGE-007 批量/导出 | 原完整授权集合，明确本页/全匹配与选择状态 | 把页面15条当完整导出；扩大批量资格 | 原导出独立服务保原协议 | 工资完整期间导出 / 仅当前页导出却称全部 | [D-domain]/[D-analysis-gs] |

### 7.2 同集合、同快照的精确定义

对一次分页请求，集合F必须在服务端由以下条件共同确定：

- 当前真实身份、有效角色和原数据权限；
- 原业务资格与状态；
- 已应用搜索和筛选；
- 原排序、稳定次键；
- 本请求的业务观察时点/浏览版本约束。

total=count(F)，目标页=page(F)。二者不能使用不同过滤条件或不同读取快照。读多次SQL时使用同一连接的一次只读一致快照；**不是跨用户浏览几分钟保持长数据库事务**。

必须复用反例：

- 候选1–15都不符合资格，16–31符合；pageSize=15。
- 正确第一页返回15条合格项，第二页返回1条，total=16。
- 不可见/不合格项不计入total，不在首屏留下假空页，也不通过“拉更多候选再试几次”形成无上限扫描。

### 7.3 历史浏览按原查询契约

原有精确跳页的页面接中央严格跳页组合，在原授权集合内定位目标页。SLA「历史标准」保留原跳页、前后页、刷新、浏览上界及旧 `beforeVersion` 兼容。新版本加入后，原浏览会话继续使用原范围，按原刷新动作才进入新的浏览范围。非法输入产生零请求。

原有逐页、游标或追加续读的列表沿用原请求、状态与按钮。订单单据历史保留「读取更早记录」，实际读到第21条时前20条仍按原顺序和版本留在列表内。保留首末端、失败重试和返回位置。以同一账号、筛选和原记录在现有 Acceptance 做前后对照，按 DXUI-PAGE-005 验证实际能力。


### DXUI-PAGE-008：严格跳页、旧总数与空页恢复

统一用 Astryx 按钮／TextInput／错误反馈组合拦截原始输入后再发请求。0、负数、非整数、非数字、空值、超出合法末页和输入法尚未完成的字符，均不得发请求；非法提交显示错误，保留最后确认页。不同筛选、排序或角色的数据不是当前范围；新结果回来前，旧 total 不参与校验和派发，迟到的旧响应不得恢复旧状态。最后一页删空或授权变化后，空页不等于零条；若仍有数据，保留准确 total 和明确可达的有效页恢复入口，并测试按钮与 Enter 两条路径。服务失败不得清除已确认结果或误报空。

**禁止直接用官方 `Pagination variant="input"` 的 `onChange` 发业务请求。** 固定版内部的 `NumberInput` 可能将越界数字夹为合法页，回调此时已拿不到原始非法值；`useTablePagination` 也不是严格跳页的替代。正例：只有 7 页输入 999，提示并产生 0 次请求；反例：悄悄发第 7 页。选择第 3 页有效时，只发一次目标请求。验证真实网络请求计数、角色切换、越界空页和 IME，不只看输入框外观。[固定版分页实现](https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Pagination/Pagination.tsx)

## 8. 弹窗、抽屉、菜单与折叠

| 规则 | 默认选法 | 禁止做法 | 例外触发条件 | 正例 / 反例 | 验证与证据 |
|---|---|---|---|---|---|
| DXUI-LAYER-001 选型 | 原位少量信息Dialog；持续侧边工作区Drawer；锚定短内容Popover | 只因更现代把原窗变抽屉；hover成为唯一入口 | 新页面按信息量/保留上下文需求选择且写入模板 | 收货在原位小窗 / 跳风险或另一订单页 | [O-dialog]/[O-drawer]/[D-receipt-dialog] |
| DXUI-LAYER-002 焦点 | 打开进入有意义位置；关闭回真实触发点，原滚动保持 | 关闭回body；刷新整页；焦点穿透背景 | 触发元素已删除时回最近逻辑位置并验证 | Esc回收货按钮 / 回页首重新找行 | [O-layer]/[D-pr1073] |
| DXUI-LAYER-003 关闭与草稿 | 信息窗Esc/关闭可用；编辑窗保原dirty guard；loading不使关闭丢状态 | 把外点即关套所有表单；关闭当提交完成 | 原必须确认流程用purpose/受控状态符合原协议 | 未保存时原确认 / 草稿悄悄丢失 | [O-dialog]/[D-system-dialog] |
| DXUI-LAYER-004 多层 | 一个全局overlay owner；只最上层处理Escape；portal继承同主题 | 两套宿主抢焦点；新层在原生modal下面不可点 | 过渡legacy宿主必须登记、专测与退出 | 预览关闭回收货窗 / Esc一次关两层 | [O-theme-source]/[O-layer]/[D-system-dialog] |
| DXUI-LAYER-005 系统确认 | AlertDialog 承载确认和提示，Dialog 承载结构化业务缺项，共用原 Promise 队列和主题 | 每页自建遮罩；空字符串当取消；失败还返回true | 原prompt有字符串输入，保其精确返回语义；尚未迁移的调用沿原入口 | cancel仍cancel / 点击关闭被当确认 | [D-system-dialog]/[O-alertdialog] |
| DXUI-LAYER-008 提交纠错 | 一次提交最多一窗，说明动作、真实错误类别及范围；已知字段可从「去填写」切到原步骤并聚焦，保留页内提示 | 输入或后台读取连弹；猜测不可定位字段；结果未知时另提命令 | 仅支持已有的安全重读或原幂等核对；已确认成功而读取失败只重读 | Esc回触发点、修正后沿原动作提交 / 关闭当成功或再次写入 | [D-system-dialog]/[D-document-editor] |
| DXUI-LAYER-006 折叠 | Collapsible显式isOpen/defaultIsOpen；按页面契约 | 默认把所有摘要收起；CollapsibleGroup误关当前节点 | 历史区原懒加载保持，已批准多PO展开例外 | current初开即展开 / 多一次点“展开” | [O-collapsible]/[D-detail] |
| DXUI-LAYER-007 内容/小屏 | 在窗内保持字段/标题/关闭可达；必要按已定响应方案全屏 | 为高度删字段；固定高度遮住确认；页面和窗双滚错层 | 原详情需要全页而非窗时保原路由 | 凭证和历史仍可读 / 只剩4个数量 | [O-dialog]/[O-bottomsheet] |

## 9. 上传、凭证、媒体与打印

| 规则 | 默认选法 | 禁止做法 | 例外触发条件 | 正例 / 反例 | 验证与证据 |
|---|---|---|---|---|---|
| DXUI-FILE-001 选择/上传 | FileInput承载选择；原prepare/hash/intent/OSS/finalize负责上传 | 换组件就换协议；选中文件显示“已上传” | 原无需上传的本地导入独立标明 | 已选择→上传→待确认→成功 / 选择即成功 | [O-file]/[D-upload] |
| DXUI-FILE-002 失败恢复 | 每文件独立状态、原重试/恢复、限并发 | 一项失败清空全队列；全部重传；重复业务提交 | 原批次必须整体提交时保原原子语义 | 只重试失败项 / 刷新失去成功项 | [D-upload-recovery] |
| DXUI-FILE-003 授权 | 预览/下载仍走原服务、绑定与有效凭证校验 | 暴露裸存储URL；把母单ID/可见图标当授权 | 原公开资源明确公开才可直接链接 | Tools授权入口 / 猜附件ID就下载 | [D-tools-attachments]/[D-pr1073] |
| DXUI-FILE-004 预览 | 图片/视频用Thumbnail/Lightbox，其他类型沿原预览能力并用Astryx壳 | 把PDF当image丢页；引另一UI框架查看器 | 非UI解析/渲染引擎可登记平台边界 | PDF原预览可用 / 图片灯箱打不开就删链接 | [O-lightbox]/[D-tools-routes] |
| DXUI-FILE-005 文件名/数量 | 显示名称、有效状态、原日期/操作者；长名有可达完整阅读 | 为美观删版本/操作者；旧凭证冒充当前 | 原文件名截断契约可用，触屏键盘必须有完整方式 | 最新/历史清晰 / 同名文件看不出版本 | [D-documents] |
| DXUI-FILE-006 打印/导出 | 保原业务内容/模板与合法数据集合； UI壳用唯一底座 | 屏幕分页截断导出；打印只剩可视DOM；遗失签字/条款 | 原正式文档版式独立于交互UI登记 | 全条款/全合法明细 / 只打当前15行 | [D-document-editor]/[D-domain] |

## 10. 异步、异常与事实完整性

### 10.1 所有模板必须实现的状态矩阵

| 规则/状态 | 默认呈现与动作 | 禁止 | 例外/边界 | 正例 / 反例 | 证据/检查 |
|---|---|---|---|---|---|
| DXUI-ASYNC-001 首次加载 | 原位Skeleton/Spinner与可访问说明；导航仍可用 | 所有请求完成前整页空白 | 身份未确认时保持原保护，不先露业务 | 任务先显示、历史后载 / 历史卡住正文 | [O-skeleton]/[O-spinner]/[D-foreground] |
| DXUI-ASYNC-002 刷新加载 | 保已知数据和时点，局部更新；写操作资格按原新鲜度 | 假装旧数据最新；全页跳动清空 | 权限撤销应立刻清除不再可读数据 | “更新中”+旧时点 / spinner结束旧值无提示 | [D-foreground]+原权限 |
| DXUI-ASYNC-003 真空 | EmptyState说明本单/本筛选无记录；允许原合法动作 | 空即无权限；空时造默认记录 | 有权无记录仍允许原看板入口 | 进入本单空看板 / 入口被无记录吞掉 | U生产入口/[D-fact-links] |
| DXUI-ASYNC-004 无结果 | 说明筛选无结果，保筛选和重置入口 | 说“系统暂无数据”；自动清空用户条件 | 原搜索超长/非法单独校验 | “无匹配结果” / 查不到就默认全部 | [D-live-search] |
| DXUI-ASYNC-005 读取失败 | Banner/局部错误+原重试；错误不覆盖已知事实 | 失败转空数组、零或“暂无记录” | 敏感资源沿原不泄露响应 | 历史失败不挡任务 / 失败显示收货0 | [O-banner]+业务状态 |
| DXUI-ASYNC-006 无权 | 沿原403/404和入口资格，不读取越权内容 | 按前端角色自行拼授权；用缩小结果绕过整单拒绝 | 领域原有部分范围接口仍按原契约 | #1073厂权限用户拒绝 / 返回一个PO的小窗 | [D-receipt-service] |
| DXUI-ASYNC-007 未知 | “—/待核/暂不可计算”，保具体原因；无数值进度 | unknown变0或indeterminate动画；未知数量参与合计 | 真实处理中的indeterminate是另一状态 | 完成时间待核 / 不知道就写未完成或0 | [D-home-progress]/[O-progress-source] |
| DXUI-ASYNC-008 部分数据 | 明示覆盖/缺项；已知与未知分开，合计有范围 | 部分数据冒充整单；把完整性标记当权限模型 | #1073整单授权不重切PO范围；首页旧覆盖事实不擅改 | 部分日期待核 / 一PO有日期就说整单已定 | [D-home-facts]/[D-pr1073] |
| DXUI-ASYNC-009 提交中 | 原按钮busy、避免重复写；保原取消/恢复 | 按钮变灰当后台已完成；不断重试写接口 | 可中断动作仅原协议允许 | 一次业务命令 / onClick+clickAction双写 | [O-button]/[D-domain] |
| DXUI-ASYNC-010 结果未知 | 明确“结果待确认”，查询原业务结果/恢复入口 | 超时即失败并重新创建；静默成功 | 原已幂等且允许安全重试沿原协议 | 查询同一intent / 新建第二收货 | [D-upload-recovery]/[D-domain] |
| DXUI-ASYNC-011 过期响应 | request/order/query/身份与当前一致才落屏；取消/代次保护 | 切A到B后A晚响应覆盖B | 原组件共享缓存须按原范围键隔离 | 小窗response.orderId匹配 / 显示另一单历史 | [D-receipt-dialog] |
| DXUI-ASYNC-012 非关键数据 | 原本非一致性读取组的历史、附件、风险扩展保独立状态和lazy；#1073汇总/历史/凭证元数据保持原同快照接口 | Collapsible替换后提前mount全部history；增加逐行请求 | 原首屏决策必需数据保其依赖 | 点历史再读 / 15行一开各查历史 | [D-lazy-history] |

### 10.2 信息守恒检查

迁移前登记“事实ID、来源字段、可见角色/范围、出现条件、原位置、格式、操作入口、默认展开状态”。迁移后逐项对照：

- 不用“字段总数没变”掩盖删A加B。
- 真实0、null、空、未加载、读取失败、无权是不同值域。
- 去重复必须同对象、同事实、同范围、同状态；不能按文案相似度删除。
- 权限决定哪些数据可读；组件决定如何显示已获授权事实；两者不互相替代。
- 汇总、风险、排序、责任与SLA由原领域决定，不在UI适配层再算一套。

## 11. 窄屏、键盘、中文输入法与难例

| 规则 | 默认选法 | 禁止做法 | 例外触发条件 | 正例 / 反例 | 验证与证据 |
|---|---|---|---|---|---|
| DXUI-ACCESS-001 窄屏 | 原信息顺序，官方响应布局；复杂表/流程局部横滚 | 全页横溢；隐藏列/节点；把所有表重排卡片 | 已批准移动读法可以实例化同一字段集 | 板房横滚仍7阶段 / 手机少两阶段 | [O-grid]/[O-scroll]+D页面契约 |
| DXUI-ACCESS-002 放大/长文本 | 真实缩放/中文字体验证；边界关系和字段完整 | 禁缩放、锁root字号、降低字级应付长内容 | 原受控媒体surface独立测试 | 200%下可读可操作 / 字重叠或按钮消失 | [O-text]/[O-theme-source]；测试场景为建议 |
| DXUI-ACCESS-003 键盘 | Tab次序按原DOM/任务顺序；Enter/Space作用正确；焦点可见 | CSS重排与焦点相反；只有hover动作；消除outline | 原复杂grid键盘规则保留 | Enter进入真实节点 / 只有鼠标能点 | [O-focus]/[O-link]/[O-layer] |
| DXUI-ACCESS-004 IME | composition期间不命令提交/搜索；原防抖与代次 | 候选Enter触发保存、Escape关闭页面层 | 原键盘事件需同时检查composing/229兼容 | 拼音候选确认后再查 / 选字时提交 | [O-ime]/[D-live-search]/[D-search-select] |
| DXUI-ACCESS-005 触屏 | 不依赖hover；官方触屏呈现须保原业务；点击区不被相邻元素遮 | 小图标遮节点、hover tooltip当唯一信息、缩控件 | 核实官方adaptive确等价后可用 | 手指开PO选择并返回 / 无法读title | [O-selector]/[O-popover] |
| DXUI-ACCESS-006 读屏 | 唯一label、表头/单元格关联、忙/错/未知语义 | 双轨都只叫进度；隐藏值却aria读0；重复播报% | 组合overlay文本可aria-hidden，原轨提供准确label/value | 自然与实际独立读出 / 两次读同一百分比 | [O-progress-source]/[O-table] |
| DXUI-ACCESS-007 动态 | 尊重系统减弱动态；原实时看板暂停/可见性策略 | 在后台持续拉数；未知值用无限动画装饰 | 真实处理中可有loading，保可理解说明 | 页面不可见按原暂停 / 每行常转圈 | [O-theme-source]/[D-production] |
| DXUI-ACCESS-008 本地化 | InternationalizationProvider +已存在zh-CN目录；达兴业务词表独立 | 只翻可见按钮漏aria/校验；locale改变SLA时区 | 其他语言走同目录策略，不分叉组件 | 中文跳页标签和错误 / 页面中文弹窗英文 | [O-i18n]/[O-package] |
| DXUI-ACCESS-009 边界长串 | 长PO/款号/UUID/URL/文件名用合适断行，身份仍完整 | 按名称截断后当ID；把长日期缩短 | 仅原批准的摘要可折叠，完整值仍可达 | 长款号本列换行 / click绑定截断字符串 | [O-text]/[D-home] |
| DXUI-ACCESS-010 高密度组合 | 按最坏字段/多状态/多PO验证布局；模板内统一处理 | 普通数据截图通过就宣称全部边界通过 | 只需覆盖实际发生或业务允许边界，不造无关压力 | 长状态+多日期仍可读 / 一个短样本作为全站证明 | 页面fixtures |

已核官方FormLayout的horizontal-labels有自身响应行为，Grid columns={数字}不会自动降列。不能因使用官方组件，就跳过窄屏与具体中文内容验收。[O-form][O-grid]

## 12. 未见场景与统一扩展流程

### 12.1 AI面对新场景的唯一处理路径

1. 明确业务任务、原字段、权限、真实操作、输入/输出、可用空间和必须保留的行为。
2. 查组件目录；有已批准相同场景原件用法则直接采用。
3. 无匹配时查固定版官方export、类型、源码和文档；名称近似不算证据。
4. 官方原件不完全满足，先论证官方组合。组合放统一packages/ui所有者，不在页面贴CSS。
5. 仍不足，写一份缺口记录：最小反例、已试官方组合、失败条件、需要的最小新增能力、业务等价性与性能影响。
6. 扩展经集中review与整份/定点方案批准后，只实现一份；登记API、规则ID、适用范围、测试与兼容。
7. 若必须改变已批准可见效果或操作路径，先给具体对照，交Eric裁定；不能把组件限制转嫁为删字段或新操作步骤。
8. 在批准前，旧页面维持原已批准实现；新需求不得偷用第二库或未登记CSS。其它已明确工作可继续，不把整个任务无限暂停。

### 12.2 真实难例与处理结论

| 难例 | 原件/组合论证 | 结论/何时才E |
|---|---|---|
| 座舱双轨条内百分比 | 两个官方ProgressBar +整轨Text覆盖；未知分支独立 | 先C；触屏极小fill与定稿几何无法通过公开能力满足时，才提一个统一E |
| 关键长状态要胶囊 | 普通Badge可能截断；先StatusDot+Text，或公开主题target保持原胶囊 | 先C；不允许每页覆盖内部span |
| 多轮/并行生产流程 | Stepper按索引推状态不合适；Button/Badge/布局读取原模型 | C即可；不重新造状态机 |
| 金额/数量严格拒绝越界 | NumberInput钳制有风险；TextInput+原解析+FieldStatus | C；不为了“原件更多”修改金额 |
| 中文多行表头 | header ReactNode；统一主题公开target/官方TableHeaderCell | 先C并运行核证；不猜props |
| 现有跳页与旧游标共存 | 统一密度、居中和按钮大小；按原页面能力选严格跳页或逐页／续读 | 保留原数据契约与浏览边界，按 DXUI-PAGE-005 分别验收 |
| PDF/Office凭证 | Lightbox仅image/video；保原授权预览引擎+Astryx壳 | 登记平台边界；不引第二套UI组件 |
| 合同富文本/排程/图表 | 先现有core组合；确需外围包再查已发布制品 | 统一候选审查；不凭包名直接接入 |
| 旧浏览器缺官方必需CSS能力 | 核实际支持矩阵与固定版发布CSS；集中兼容论证 | 未解决不能宣布该支持环境迁移完成，不能暗降浏览器支持或永久旧UI双轨 |

**统一扩展必须包含：** 真实业务需要、O/C失败证据、唯一代码owner、公开props、语义tokens、SSR/首帧/portal/键盘/输入法、数量/权限/SLA不变证明、bundle影响、上游升级策略、回退路径。稳定扩展不强设撤销日期；上游出现等价原件时集中评估替换。临时legacy豁免必须有退出批次。

**不允许的回退：** 每页再造旧控件、引第二UI库、关掉真实入口、删业务数据、把错误装空态。已迁页面的正常回退优先回上一个通过的Astryx实现；过渡阶段回旧版本也必须按完整页面/批次回退，并登记为未迁完成。

## 13. 完整样章一：管理座舱首页

### 13.1 页面身份、职责和不变项

- 页面ID：cockpit-home；真实入口为 /ui/digital-cockpit 的首页工作区。
- 基线：release@1d163c5e…；实现主要在 digital-journey-cockpit.tsx、cockpit-home.tsx及其子件。
- 职责：在原授权和筛选范围内看订单风险、当前任务、自然/实际进度，进入同一订单的原工作区。
- 业务事实：订单/PO/数量/时点/进度分母/责任/SLA都沿原投影和formatter。
- 本次全站化：把所有承载控件纳入Astryx唯一底座，不重新安排首页区域与列序，不删字段，不新增流程规则。
- 适用规则：TXT、STATE、ACT、TABLE、PAGE、ASYNC、ACCESS以及本章HOME规则。
- 当前状态：局部Astryx适配，不是全套；旧BusinessTable、StatusBadge、分页、原生输入/details以及ReceivingDialog尚存在。[D-home][D-cockpit][D-astryx-adapter][D-receipt-dialog]

### 13.2 原页面区块、字段与承载映射

| 原区块/字段 | 必须保留的信息/行为 | 目标原件/组合 |
|---|---|---|
| 页头 | “生产管理总览”、原actions、数据时点和原入口 | LayoutHeader +Heading/Text/Button |
| 基础筛选 | 客户、整单状态、综合搜索、更多筛选、重置 | 官方输入/Selector +统一筛选组合，原控制器 |
| 更多筛选 | 订单范围、跟单、品类/款式、大/小流程、业务状态、计划与交期、风险、创建日期区间 | 官方表单控件＋统一筛选组合；保持原区域内展开和原控制器，不改成Popover/Dialog |
| KPI | 当前六项及原范围；未知为— | Card/Stack/Text +原summary；不从本页行算 |
| 主表 | 整单状态、款图、订单/款名、客户/下单数量、PO与日期、当前任务/风险、交货日期、其它信息；原有权限动作 | 官方Table及统一复杂单元格；顺序不变 |
| 整单状态 | 主状态、交期/计划说明，长状态原列内完整 | 状态组合+Text wrap |
| 款图 | 原图片/未上传空态、比例与原查看动作 | Thumbnail/原授权图片，不能换成无关占位图 |
| 订单身份 | 款名/款号、纯开发或已下单、业务订单ID、跟单 | 同一事实组合；UUID不充业务单号 |
| 客户/数量 | 客户缩写/名称与原下单总数及单位 | Text，数字格式原样 |
| PO与日期 | 稳定排序的首PO；PO/颜色/数量/出货日；另N个PO原位展开 | 官方Text/Link动作或Button +Collapsible；不新造PO关系 |
| 当前任务 | 原代表节点名称、状态、负责人、计划、实际、±天数、责任结果、原必要阻断 | 统一节点摘要组合 |
| 风险 | 原风险计数/文案和独立风险下钻 | 真实Button/Link入口 |
| 交货日期 | 列头“交货日期”；原“预计日期：”及完整日期；自然轨；原“实际进度：”与完成事实；实际轨 | 统一日期事实组 +双轨组合 |
| 其它信息 | **生产进度 → 收货数量 → 船样寄出** | 统一三事实纵向组合，各自真实动作与状态 |
| 原删除/更多动作 | 原权限、原后端命令、原确认 | IconButton/DropdownMenu，不能扩权 |
| 分页与反馈 | 原pageSize/查询/total、居中跳页目标、准备搜索/更新/失败等 | 中央严格跳页组合 + 原控制器；异步矩阵 |

这是逐字段替换承载控件的清单，不是允许把三项信息换成三卡片或新导航。[D-home][D-cockpit][D-fact-links]

### 13.3 DXUI-HOME-001：双轨必须保留独立业务含义

| 项目 | 自然时间轨 | 实际业务轨 |
|---|---|---|
| 数据来源 | 原visualProgress及useScheduleObservation；必要时沿原naturalTimeRatio | 原visualProgress.actualRatio |
| 表达 | 原业务时钟下的自然时间进度 | 原领域实际完成进度 |
| 禁止替代 | 不拿“已完成节点数/全部节点数”代替 | 不拿实收/应收、计划百分比或统一阶段等权代替 |
| 名称 | 整单/开发自然时间进度 | 整单/开发实际进度 |
| 未知 | —、暂不可计算 | —、暂不可计算 |

原比例已知条件为finite且在[0,1]内；只有ratio严格等于1才显示100%，其他接近1的显示上限保留99.9%。原进度分母、业务观察时钟和停止状态逻辑不变。[D-home-progress]

**推荐官方组合：**

- 两条轨分别由官方ProgressBar绘制。
- isLabelHidden=true、hasValueLabel=false，保正确可访问名称。
- 使用官方Grid/Stack与Text，在**整条轨道**上覆盖原格式化百分比。
- 覆盖文本不在fill内部，不随0.1%的fill一起被裁；避免读屏重复播报。
- unknown分支不能把undefined/NaN传给官方组件，因为其源码会归整为0；也不能改成isIndeterminate无限动画。统一组合使用静态未知展示和说明，不产生虚假的数值进度。
- 官方文档不推荐条内label；本条明确登记为**达兴稳定业务组合**。两根轨不同含义，不是同一操作重复画条。
- 轨高、条内字体、圆角、左右边界从批准基线及同屏实证确定，不把官方默认轨高或旧15px直接当终值。
- 官方触屏非零fill有最小可见长度；必须测0.1%等极小值。先核公开主题/组合能否保持业务表达，再判断是否需一个统一扩展，禁止页面改内部私有变量。[O-progress][O-progress-source]

### 13.4 DXUI-HOME-002：日期、字号与对齐

1. 保留当前批准结构和标签关系：交货日期列，预计日期事实组，自然轨，实际进度/完成日期事实组，实际轨。当前源码就是这一序列；没有图证据不得另排。
2. 日期标签和数字日期使用同一选定字号，保完整年/月/日，不为挤宽缩小日期。
3. 两轨左右边界相同；同组标签、日期与轨道关系稳定。多日期增加内容高度，不与轨重叠，不跨入相邻列。
4. 多PO日期按原真实范围列出，稳定排序并对相同日期去重；异日不合并成一个“代表交期”。
5. PO交期不完整时明确“部分日期待核”；没有可信日期为—。
6. 只有原completed事实才显示真实完成日期；已完成但时间未知显示“完成时间待核”；未完成按原“未完成”，不填一个估计日冒充实际。
7. 首页不因详情冒号局部调整而被全局CSS改动。

**正例：** 两PO分别为2026-11-21、2026-11-23，两个完整日期都保留；同字号；两条轨平齐；日期不会盖住自然轨。\
**反例：** 只取最早PO日；日期10px而标签不同号；异日挤同一行盖住进度；未知完成时间填当天。

当前源码的日期/%为10px、轨高15px只是R类观察，**不是官方标准，不是当前已确认计算样式，更不是全站token定稿**。[D-home-css][D-home-progress]

### 13.5 DXUI-HOME-003：多PO只默认展示一条，事实不能丢

- 沿sortedCockpitPoLines的稳定顺序取首项，不随机挑“主PO”。
- 多PO显示“另N个PO”可点击原位展开，键盘/触屏均可用。
- 展开保持每条PO号、颜色、数量、出货日期；不把首PO数量当订单总数量。
- 此处是Eric已批准的信息展开例外；不能扩展为把负责人、风险、期限都藏起来。
- 展开/收起不重新绑定母单，不重置分页筛选，不触发不必要的整单重读。
- 多PO的日期完整性、进度分母和数量口径仍由原读模型决定。[D-home][D-pr1072]

### 13.6 DXUI-HOME-004：左侧文字与任务去重复

- “计划待核”等必须在原列内完整换行；不能恢复45px强制单行省略、缩字或删字段。
- 款名/款号、交期风险说明、跟单等长值同时检查，不只修一个短语。
- “未指派”与“尚未安排办理人”只有**同一真实task instance、同一assignee事实、同一scope与状态**时才可去重；不同阻断不因为中文相近被删。
- ±天数颜色读取原tone/状态，责任结果独立显示。目标延后不自动等于有责；“不单独计责”“责任待核”“逾期（无责）”要保留。[D-home][D-framework]

### 13.7 DXUI-HOME-005：右侧三项保持顺序、真实可操作

| 项目 | 必须成立的动作 | 无记录/多记录边界 | 禁止 |
|---|---|---|---|
| 生产进度 | 按服务端真实dashboardRecord进入 /ui/production-dashboard?workspace=display&motherOrderId=…；有资格且无记录仍进本单空态 | 多工厂候选按原明确选择；不默认第一家 | 只改蓝色无link；跳其他单；以无记录吞入口；扩大production-reporting权限 |
| 收货数量 | 独立原位本单收货小窗，详见#1073契约 | 合法整单空记录按原空态；错误/无权分开 | 继续开风险；恢复旧PO授权模型 |
| 船样寄出 | 从真实bulk_ship_sample任务记录取入口，record/task/instanceId一致 | 单任务直达；多个PO/轮次/实例按原选择；确无记录按原说明 | 伪造任务URL；隐藏入口掩盖慢；把站内跳转变整页刷新 |

三个信息区的标签/状态使用同一组合进行垂直对齐、内边距与文本居中校验，容器不碰文字；**不借“居中”把整个右栏重新排成横向**。可点入口有可见链接/按钮状态与focus，不用颜色独自承担可点含义。[D-fact-links][D-record-link][D-pr1072]

### 13.8 DXUI-HOME-006：#1073整单收货小窗完整契约

**权威顺序：本次最新用户要求 + #1073当前实现。旧B方案按可见PO重切授权的段落不适用于此窗。**

#### 权限和请求

- 用正式母单orderId定位。
- 请求 GET /digital-production/orders/:orderId/receipt-summary。
- 保留canOpenOrderReceiving(actorRoles)入口资格。
- 保留DigitalProductionAccessPolicy.assert(actor,'order',orderId,'technical')整单授权。
- 仓管继续受现有负责范围约束。
- 仅有某一个工厂访问权，不获得整单收货数据，也不自动得到“部分PO小窗”。
- 同一连接REPEATABLE READ READ ONLY读取数量、明细、历史和凭证。
- 前端校验响应orderId与请求一致，关闭/换单取消旧读取。
- 预览下载仍走原Tools路径和授权；不存在“母单ID正确就可以下载”的简化。[D-receipt-service][D-access][D-tools-attachments]

#### 字段与原数据来源

| 区域 | 必须保留 |
|---|---|
| 标题/身份 | 本单收货明细、订单标识 |
| 汇总 | 原收货状态、特殊结案状态、应收、累计实收、未收、超收 |
| 每PO | PO、颜色、状态、实收/应收、收货次数、送货单数量、次品、装箱数量 |
| 差异 | 有事实时原收货差异处理、装箱差异处理 |
| 收货记录 | 原实际收货日期/时间、实收数量 |
| 历史 | 原收货、更正、装箱、差异处理 |
| 凭证 | 有效原附件、名称、预览、下载 |
| 状态/动作 | 加载、失败重试、无权、关闭、焦点恢复 |

原数据链包括digital_production_child_lines、receiving_receipts、receiving_batches、有效receiving_receipt_corrections、原readNativeReceivingTotals、readReceivingDocumentHistory和Tools附件。UI换成Dialog不新建统计来源。[D-receipt-facts][D-receiving-summary][D-receipt-dialog]

#### 必测反例（已有测试场景复用，非本轮新实测）

- 双PO应收分别4、6；实收1、5：原整单有权账号得到应收10、实收6、未收4、超收0。
- 第二PO有效更正为9：整单实收虽为10，但**未收3、超收3，仍部分收货**；不能用整单总差0抹平。
- Root、原负责仓管按原资格与整单范围读取。
- 只获第一工厂访问权的账号被拒绝，响应不泄露PO/附件；不能返回一个PO的“可见范围”窗。
- 无效母单按原拒绝；凭证原授权链继续有效。
- Esc/关闭返回原收货按钮焦点并保持原行位置，风险窗状态独立。[D-native-test]

**易混点：** 首页收货摘要的scope='visible'/“可见PO”目前可能由“已记录PO覆盖情况”产生，不等于此小窗创建了PO权限。把它列入事实完整性/文案核对项；本次底座迁移不得静默修改读模型或恢复旧授权设计。[D-home-facts]

### 13.9 首页异步、窄屏与操作步骤

- 保留各入口原有分阶段和惰性加载；船样任务正文与其历史分别验收。#1073收货summary的数量、历史、凭证元数据仍由原接口在同一只读RR快照读取；图片/文件字节按原授权入口按需加载，不能为UI拆开一致性读取。
- 搜索保持原IME与原控制器，清空、快速改词、返回、翻页各自核请求。
- 窄屏沿原页面规则，复杂内容局部横滚；不把桌面八列的固定宽度推到所有模块。
- 进入生产、收货小窗、单任务船样等原直接路径不增加确认或菜单层。
- 默认首PO+展开是已有批准例外；记录它的动作变化，不能笼统宣称每个信息点步骤都零变化。
- 旧船样任务接口约2.17秒、历史等待约0.5秒来自此前现场证据，**不是本轮当前版本实测**。UI迁移不能删入口规避它；任务接口、历史、入口资源三段仍按原性能方案分别验收，不能宣称换Astryx已解决。

### 13.10 首页验收用例全集

| 用例ID | 条件 | 通过条件 |
|---|---|---|
| HOME-V01 | 0%、0.1%、99.9%、100%、未知；两轨相反进度 | %完整在整轨内；真实比例/分母不变；未知不变0；读屏名称独立 |
| HOME-V02 | 多PO同日、异日、一项缺日；长年月日 | 同日去重、异日全保、缺日提示；同字号；不重叠 |
| HOME-V03 | 计划待核、长款号/跟单、长风险说明 | 原列换行、无裁切、不缩字、不删字段 |
| HOME-V04 | 同一任务assignee重复 vs 不同任务/阻断 | 仅同事实去重；不同阻断保留 |
| HOME-V05 | 生产有权无记录、有记录、无权 | 本单空态可达/本单记录可达/原拒绝；不跳别单 |
| HOME-V06 | 船样单任务、多轮、多PO、真正无任务 | 原记录直达或明确选择；无伪造URL；返回上下文保留 |
| HOME-V07 | #1073双PO、有效更正、厂权限反例、凭证 | 整单原权限；未收/超收不抵消；原下载授权 |
| HOME-V08 | 快速换母单/关闭后旧响应晚到 | 不串单、不回填已关闭窗、不新增重复请求 |
| HOME-V09 | 键盘/触屏/窄屏、开关小窗 | 所有入口可达；焦点恢复；右三项顺序不变 |
| HOME-V10 | 翻页/搜索/详情返回/资源首次加载 | 数据集合、total、KPI、排序和时点不变；请求/首屏无回退 |
| HOME-V11 | 原生图证据 | 绑定真实SHA、角色、订单、时钟、视口/字体；缺最终批准图则标未核，不打“通过” |

## 14. 完整样章二：订单详情

### 14.1 页面身份与保护边界

- 页面ID：cockpit-order-detail；从原座舱订单入口进入，示例订单沿TEST-SLA-ec23b6b4等原fixture。
- 关键实现：cockpit-detail.tsx、cockpit-stage-progress.tsx、cockpit-framework-nodes.tsx、cockpit-milestones.tsx、cockpit-node-dates.tsx、cockpit-date.tsx。
- 保留原区块与真实动作，当前节点默认展开。
- framework A/B里程碑与legacy流程按原数据分别呈现；不强制全站统一7/8/9节点。
- 资料/版本/历史/轮次/终止与只读状态沿原合同；不为了Astryx组件统一而新增或删除业务字段。[D-detail][D-framework][D-milestones]

### 14.2 原分区、字段和目标组件映射

| 原分区 | 必须保留的内容 | Astryx承载 |
|---|---|---|
| 返回/工具栏 | 原返回、actions、数据时点；页码/筛选/滚动上下文 | Link/Button/Toolbar +原路由 |
| 身份/款图 | 款图、款名、整单状态、业务订单ID、客户、订单类型、跟单、下单总量、创建日期、资料版本、原人员入口 | Layout/Card/MetadataList/Text/Thumbnail |
| PO事实 | 原PoOrderFacts全部条件字段与范围 | 原事实模型+MetadataList/Table |
| 大流程/里程碑 | 外层固定七大流程；A/B 九／八个里程碑在所属阶段明细，原日期、进度、差异和选择动作可查 | 统一真实节点组合，非自动推状态的Stepper |
| 当前节点摘要 | 名称、状态、原办理/查看、负责人、责任结果、原计划信息 | Card/官方动作/状态+Collapsible |
| 节点详情 | 原目标/期限、实际、轮次、次数、操作者、阻断、材料 | 同字号日期/事实组合、原材料入口 |
| 小流程明细 | 阶段、节点、计划完成、实际完成、差异、责任、状态、筛选/全部节点/查看更多 | Table、真实节点Button/Link |
| 风险 | 原风险、计数、原节点定位 | 原风险数据+统一列表/动作 |
| 相关单据 | 原目录、分类、版本、轮次、原查看/附件动作 | List/Table/Collapsible/原授权入口 |
| 操作日志 | 原日志与原加载策略 | 官方List/Table/异步组合 |

当前桌面实现current/risk并列、node全宽、documents/log并列，窄屏按原顺序转纵向并对流程/必要表格局部滚动。**这是本页实例，不是所有详情统一列比或固定断点。**[D-detail-css]

### 14.3 DXUI-DETAIL-001：真实节点身份与状态

1. 选择绑定真实instanceId，以及原scope/PO/work/round上下文；同名节点不能按名称合并。
2. 里程碑选择按原scope/work IDs。直接成员与真实前置依据分开；共享工作只保一个实例。节点行实际定位同一实例，材料和日期也来自该实例。
3. 原可办理任务、其他可办理记录、可读任务、其他可读记录的选取顺序保持。
4. 已取消/终止记录不被新按钮重新赋予办理权；原合法只读历史仍能打开。
5. 节点是实际Button/Link，键盘和鼠标都执行原动作；选中色不算功能完成。
6. 不用Stepper.activeStep将前序索引判完成或后序判未开始。官方Step.status改色不能替代达兴多轮/并行/回退/责任模型。[D-detail][D-framework][O-step]

### 14.4 DXUI-DETAIL-002：当前节点显式默认展开

现实现有details open，且与selected.instanceId绑定。迁移到Collapsible时：

- 首次进入当前节点即展开。
- 选择另一真实实例时，该实例按原定稿默认展开。
- 用户主动折叠是否保留依原页面契约，不被全局CollapsibleGroup的单开模式覆盖。
- 不为“页面整洁”将原直接可见字段移入另一个小窗/页签。
- 历史资料若原本惰性挂载，仍按原首次展开加载；当前节点默认展开不意味着把所有历史/附件也预加载。[D-detail][D-lazy-history][O-collapsible]

### 14.5 DXUI-DETAIL-003：日期、完整年月日与±天数

- 保留CockpitDate原formatter，短展示仍是完整YYYY-MM-DD；原瞬时时间精度在既定dateTime/title/aria-label等处保留。
- 标签、冒号、日期使用同一字号；按原局部规则给冒号两侧视觉间距，不碰首页样式。
- 同一日期项不拆到覆盖相邻内容；多项日期在原区域合法换行，保持对应关系。
- 目标差来自cockpitDifferenceDays的原signedValue/unit/kind，不用两个展示日期相减。
- 预计日期只取同范围同采用版全部适用里程碑的最晚目标；有任一目标缺失，阶段显示待核，可展开缺项和该范围已有依据。开裁、工厂生产沿原阶段排程。可查看原阶段排程的历史正式单标「未采用里程碑计划」。原实际与差异继续引用原事实，基准不同时显示「差异按原目标」及其日期和版本。
- 保留正负号、天数、未知—；不以颜色替代数字。
- 目标差与ownSla责任结果是独立事实。+天数可与逾期（无责）/不单独计责/责任待核同时存在。
- 当前源码精确零的展示为-0，这是R类现状；若要调整需明确展示规则变更，不能趁换组件静默“修正”。[D-date][D-node-dates][D-difference][D-framework]

**条件性原字段清单不能简化成固定四行：**

节点预测、节点目标/原任务截止、native task deadline、原批次时限、各范围原截止、已采用计划完成、当前/预计完成、各批原责任窗口、生产监督事实、继承成果原完成和本轮采用完成——存在且有权的原字段继续显示。没有事实则遵循原缺失状态，不能为填模板造字段。[D-node-dates]

### 14.6 DXUI-DETAIL-004：已批准删重的精确范围

- 不恢复流程图额外加的“创建纯开发/正式单”等展示行。
- 后台创建事件、原节点点击、业务日期和计时仍保留。七大流程原「订单创建」的阶段明细打开原开发记录或正式单。创建人与时间读同一主体，只有原审批事件证明同一次正式创建时才合并展示。
- 身份卡在原创建日期组显示对应主体的创建人。开发首次发布和正式单创建分别取原有效事实，缺时刻显示未记录，不以草稿保存或登记时间代替。
- 当前节点摘要不重复显示“自身截止”。
- 原任务期限、目标日期、批次期限及相应风险/SLA仍在原应有位置。
- 不把这两项删除授权扩大成“简化所有日期”“删除所有创建历史”。[D-current-summary][D-pr1056]

### 14.7 详情异步与复杂状态

| 场景 | 规定结果 |
|---|---|
| 初开已有核心信息、历史慢 | 核心区按原可用事实呈现；历史独立busy/error |
| 切换节点后旧材料晚返回 | 检验真实instance/scope/round，不覆盖新选择 |
| 已终止/取消 | 原状态明确、原只读可达，不新增办理 |
| 多PO/多轮 | 目标、实际、差异、材料绑定同范围；不得目标取A而实际取B |
| 已完成但实际时间缺失 | 保“完成时间待核”语义，不造日期 |
| 查看权限撤销 | 按原权限清除不可读内容并拒绝动作；缓存不跨角色复用 |
| 日志/相关单据为空/失败 | 分别显示真空与失败，不互相阻塞 |
| 返回总览 | 原筛选、页码、阅读位置与选择上下文恢复 |
| 窄屏 | 原分区顺序；节点与流程完整可达，不用隐藏节点消除横滚 |
| 图片/附件失败 | 原事实区仍可读，原授权重试/下载入口保留 |

### 14.8 详情正反例与验收全集

| 用例ID | 通过示例 | 不通过反例 |
|---|---|---|
| DETAIL-V01 原分区 | 身份、PO、流程、current、node、风险、单据、日志逐项仍在原契约区域 | 套通用详情模板后日志/材料藏到新Tab |
| DETAIL-V02 默认展开 | 首开/切实例可直接读当前信息 | 每次多点“展开” |
| DETAIL-V03 真节点 | 两个同名不同PO/轮次节点分别到正确instance | 只改selected类名，记录仍是第一个 |
| DETAIL-V04 日期 | 完整年月日、标签/值同字号、无相交区域 | 只剩月日、日期变小、重叠 |
| DETAIL-V05 ±与责任 | +天数和原“无责/待核”各自呈现 | 正号自动变有责、负号消失、前端重算 |
| DETAIL-V06 条件字段 | 存在的原任务/批次/采用/继承等事实保留 | 统一四行删了原期限或另加新“自身截止” |
| DETAIL-V07 删重范围 | 仅去额外创建行和重复摘要，原事件/期限不动 | 后台创建记录或原责任窗口也被删 |
| DETAIL-V08 终态/历史 | 终止项不误开办理，历史原查看可用 | Stepper把前序全部标完成或复活取消任务 |
| DETAIL-V09 数据隔离 | 切节点、换PO、换轮次和晚响应不串；权限拒绝不泄露 | A节点日期配B材料 |
| DETAIL-V10 键盘/返回 | Tab/Enter/ESC与原返回路径一致 | 焦点跳body或返回丢筛选 |
| DETAIL-V11 性能 | 原lazy、请求合并、去重、模块拆包不退；首屏/切换/返回各有数据 | 因统一组合静态import全业务模块或全部history |
| DETAIL-V12 原生图 | 指定SHA/角色/订单/时钟/视口/字体与批准来源完整 | 静态AI图、PRmerge或未查看的截图路径当像素通过 |

### 14.9 两页批准图与已合并实现的对照结果

| 证据 | 已核内容 | 不能据此声称 |
|---|---|---|
| #1050，merge529c6a94… | 0.7.16的Button/Badge/Stack局部试点 | 全站已迁Astryx |
| #1054，merge941bc93a… | 交货日期区及双轨条内%恢复 | 当前所有像素都已复验 |
| #1056，merge1771d861… | 左侧换行、额外创建行/自身截止删重、详情冒号 | 删除后台事实获授权 |
| #1072，mergee2cd988a… | 首PO与展开、生产/船样真实入口与返回 | 原生最终图批准对应已齐 |
| #1073，merge1d163c5e… | 整单收货小窗、原权限/数量/凭证、焦点恢复 | 旧B的PO过滤仍适用，或小窗已经是Astryx Dialog |
| 当前源码 | 上述实现已在本次固定分支 | 本轮已经运行浏览器/PG/性能测试 |
| 旧试点报告与离线/静态稿描述 | 可理解历史设计与约束 | 代替当前原生运行图及Eric批准 |

已找回并静态核对 11 月 19 日获准风格的两页离线原型 ZIP，内含两份 HTML、构建记录和 README，没有 PNG，未执行或实测；部分字段为展示用示例，未连接业务 API。该包可作风格历史依据，不等于最终批准图、像素尺寸或现场功能通过。后来改动按最新确认逐项核对。[D-pr1050][D-pr1054][D-pr1056][D-pr1072][D-pr1073]

## 15. 旧 MD 逐条处置与唯一权威切换

### 15.1 处置原则

每份旧文按条款迁移，不能整份“新标准覆盖”后丢掉业务、权限或性能成果。迁移记录至少保存：旧路径/章节、旧条款摘要、适用范围、处置、目标规则ID或领域文档、替代批准、历史证据位置。

本次文档变更按以下条目一并切换 UI 规范入口：

- 新主MD标批准版本/日期/适用范围。
- AGENTS、README、规则索引只指向它作为UI入口。
- 旧UI正文完成条款映射并标superseded；原路径可留短重定向和迁移索引，不能继续写“唯一标准”。
- 领域规则仍在领域文档；主MD只引用，不复制成第二份算法。
- 未迁旧页的具体视觉基线以legacy页面契约登记，仅在该范围暂时适用，不反过来定义全站默认。
- 历史图片、PR回执、测试记录可以保存，但标H而非现行规范。

### 15.2 已核文档迁移表

| 旧实际路径 | 适用范围/冲突 | 逐条处置与新归属 |
|---|---|---|
| AGENTS.md | 执行政策有效；UI/分析与局部UI当前分指两GS | **保留**工程、安全、授权；**替换**UI索引为唯一主MD，不复制规范正文 |
| README.md | 仍有PR-01基座、packages/ui待填充、Figma作为UI GS等旧阶段表述 | **保留**工程说明；**替换**当前UI权威与过时阶段；Figma仅批准视觉证据 |
| docs/roadmap/platform-2.0-rules-index-v1.0.md | 规则索引指旧UI；历史授权不自动复活仍有效 | **保留**规则职责；**替换**UI链接 |
| docs/requirements/rework-ui-golden-source-v1.0.md | 返工实际控件为全平台标准；main仍有暂停组件库/设计系统；堆叠多轮模块规则 | **替换**上述旧定位；**迁移**通用排版到TXT/TYP等、页面规则到contract、业务事实到领域；**归档**阶段记录；旧路径留重定向 |
| docs/requirements/business-analysis-limited-ui-golden-source-v1.0.md | 分析五问/全范围聚合有效；混入UI、手机字号、座舱迭代；旧可见PO描述易误套#1073 | **保留**分析业务；**迁移**UI；**替换/限域**与#1073小窗冲突的旧口径，不能改其他原合法scope |
| docs/ui/component-page-inventory-20260921.md | 历史代码映射与UI-01/02/03；别名不等于官方组件 | **迁移**为route/component registry；旧快照**归档** |
| docs/ui/figma-pilot-baseline.md | 早期变量/字体/Button变体、Badge核对状态混杂 | **归档**早期试点；不作为0.7.16官方API或当前两页像素事实 |
| docs/ui/login-homepage-20261009.md | 登录/二维码宿主、真实入口；两分支补充不同 | **保留**认证证据；**迁移**当前登录契约，不能推广为座舱首页标准 |
| docs/roadmap/ui-reconstruction-v2/golden-region-contracts.md | 旧五图、六KPI/七流程/三列比例与像素；真实入口/返回约束有价值 | **迁移**有效业务/入口；**归档**旧布局数字和阶段规定；当前页不再套旧图 |
| docs/roadmap/ui-reconstruction-v2/pr03-cockpit.md | 旧座舱实现记录 | **归档**执行与旧版式；有效返回/权限条款引用迁移 |
| docs/roadmap/ui-reconstruction-v2/pr03-pr04-desktop-fix.md | 板房七列、窄桌面局部横滚和当轮列宽 | **保留**板房来源；**迁移**板房特例；不成为全站列宽标准 |
| docs/roadmap/ui-reconstruction-v2/fix04-ui-density.md | 当轮新工作台KPI、移动两列等，适用范围有限 | **迁移**仍有效可读性原则；**归档**阶段密度数字，不自动改成熟模块 |
| docs/engineering/r5-08-detail-documents.md | 旧“只显月日”、部分字段另看，与当前完整年月日/current默认开冲突 | **归档**旧显示方案；**保留/迁移**资料懒加载、版本、权限成果 |
| docs/engineering/r5-09-home-navigation.md | 旧日期同一行、多PO省略；身份/批量读取/返回有价值 | **归档**旧布局；**保留**性能与真实身份约束并在主MD引用 |
| docs/engineering/ui01-node-history-20260921.md | 外发只读完整历史，不是座舱额外创建行；含旧暂停组件库决定 | **保留**外发历史业务；**归档**旧定位与阶段授权；不删除审计事实 |
| docs/requirements/order-detail-target-layout-2026-08-19.md | 返工N01–N10；手机双列、验货报告默认折叠 | **迁移**返工详情契约；不能盖过座舱current默认展开 |
| docs/requirements/mobile-order-detail-info-grid-2026-08-14.md | 返工事实三列，与后文双列可能区域交叠 | **定点待核**原批准范围；明确分区后迁移，不按文件时间猜胜负 |
| docs/requirements/workflow-terminal-ui-governance-2026-08-14.md | 返工N09/N10、责任结算与手机流程折叠 | **保留**领域终态；**迁移**返工显示特例，不推广座舱 |
| docs/decisions/ui-information-architecture-20260812.md | 回货批次是返工唯一创建源；旧黑标题/紫说明视觉 | **保留**业务入口；**迁移/替换**视觉到唯一主题规则 |
| docs/requirements/cockpit-display-v1.0.md | 座舱进度/日期/数量/权限；早期七阶段等权与后续业务进度规则并存 | **保留**领域权威；明确被后版本替代的精确算法条款；UI只引用，不重算 |
| docs/requirements/cockpit-documents-v1.0.md | 资料主类、版本/轮次、附件权限、读取与返回 | **保留**业务/权限；**迁移**显示模式，不删历史/惰性读取 |
| docs/engineering/uat-pr08-list-control-audit-20261015.md及配套审计数据 | 历史路由/控件位置、中文/IME/选择/分页证据 | **保留历史**；有效行为迁规则，原测试绑定同ID；旧数量不当现覆盖率 |
| docs/architecture/business-module-boundaries.md | 服务/快照/写入/上传职责边界 | **原地保留**，主MD引用；不能让组件承担业务服务 |
| docs/governance/chatgpt-codex-construction-workflow-v1.0.md | 执行/审查流程 | **原地保留**；不另造一套UI Full/Review授权流程 |
| 旧《完整方案.md》附录design.md稿（不在仓库根） | 先前方案建议，不是已落仓库规范 | **归历史方案**；有效想法逐条论证后吸收，不以其覆盖当前批准事实 |
| DX_Cockpit_SLA_Astryx_Pilot_Review_20261119.md | 仅两页试点定位、旧图/HTML与API建议 | **替换定位并归档试点**；可保验证问题和有效约束，不能继续写全站只用B/B/S |

上述仓库路径已按当前树/相关正文核对。仓库只有根AGENTS，未发现根design.md或DESIGN.md。**规范交付时没有逐份阅读全部历史MD、所有Figma对象和每个模块的最终图**；因此未来迁移清单还应扫描旧引用并逐条挂接本表，不得把未读条款统一宣布作废。

### 15.3 特别需要显式处理的冲突

1. **底座定位：** 返工控件全站标准/暂停设计系统 → 本次Astryx全站唯一底座。
2. **视觉权威：** Figma/旧试点稿/旧CSS各自声称黄金源 → 主MD规则唯一；图像只证明指定页面、指定版本批准效果。
3. **日期：** 旧月日简写 → 本次两页完整年月日；不能改别的确为月份统计的字段语义。
4. **默认折叠：** 返工验货报告/移动流程默认折叠 → 只作用返工；座舱current默认展开不受其影响。
5. **#1073：** 旧按PO收货小窗授权 → 原整单资格/权限；首页记录覆盖标记不当新授权。
6. **旧像素：** 190px行高、150/180列宽、10px字、15px轨等 → 保具体历史来源；未证明当前批准，不升级全站。
7. **规则与执行历史：** 旧授权、旧“下一步”、旧Gate状态 → H类，不恢复为本轮施工命令。

## 16. 分批迁移、兼容和回退

### 16.1 每个页面的状态机

```text
已盘点 → 契约已冻结 → 所需官方/组合能力就绪 → 实现待验
→ 语义/权限/交互通过 → 原生视觉与性能通过 → 已迁移
→ 旧依赖已退出 → 该页面闭环
```

文档完成只能推进到“契约已冻结”，不能直接标“已迁移”。每条route还需登记overlay、历史、打印、只读、失败恢复、角色和query工作区；不是只登记主列表。

### 16.2 推荐批次和依赖

| 批次 | 任务与交付 | 开始条件 | 结束条件/主要风险 |
|---|---|---|---|
| W0 统一规则与清单 | 本方案定稿；主MD/旧条款映射；实际route/overlay/组件/事实/步数清单；两页基线证据状态 | 本次方案审核 | 入口唯一，未决条款可定位；不把未核图记通过 |
| W1 唯一底座与首批能力 | 固定依赖、Astryx子出口、中文主题/i18n、原路由Link、overlay host；两页所需表格/筛选/状态/分页/日期/双轨/节点/上传展示组合的第一份实现 | W0规则与依赖表明确 | 首帧、主题作用域、portal/焦点、旧页影响有证据；不能直接换旧根出口 |
| W2 两套复杂样章 | 完整迁首页+详情+1073窗；控件不留隐性legacy；原领域请求/权限不变 | 所需W1能力到位 | 本文HOME/DETAIL用例、真实角色、图像/步骤/性能闭合；不是只换三个组件 |
| W3 常见列表与目录 | 待办、一线、主数据、供应商等代表清单与管理目录；纳入所有私有分页消费者 | 通用列表/选择/分页验证 | 搜索、IME、资格过滤和返回保持；按原能力验真实总数与跳页或前后页、游标、追加续读；不能漏自拼分页 |
| W4 业务办理与长单据 | 回货/收货、外发、板房、返工、数字开发、大货、样衣、开裁的表单/详情/上传与历史 | 表单、矩阵、dirty/恢复、原附件能力成熟 | 各领域事实/命令/权限逐项等价；不套同一详情布局 |
| W5 复杂工作区和剩余覆盖 | 实时生产、交付日历、SLA设置/版本、财务工资、分析报表、系统管理/合同等未完成路径 | 所需数据与特殊模式闭合 | 历史/打印/导出/财务精度/实时刷新等边界通过；原跳页、原游标及原续读按各自契约保留 |
| W6 旧层退出与收口 | 清除可达legacy renderer、重复主题/token所有权、无用全局CSS与试点off回退；校验正式入口全部覆盖 | 所有route及附属能力通过 | 本文“全套Astryx”完成条件全部满足；归档证据可保留 |

批次是依赖组织，**不是本轮开PR或重新编号原功能PR**。既定功能PR的目标分支和业务责任继续按已批准范围执行。分页外观施工采用 DXUI-PAGE-005 的原能力边界。

分支处理：

- 当前数字生产功能以本次固定release为事实来源，main的依赖/消费者另有基线。
- 未来实施须重新读取获准目标分支的真实head，确认已合并变化；不能以本报告SHA当永久开工base。
- 全站规范需明确在实际交付分支生效，并通过原晋级流程进入最终交付；只把release接通不等于main/全站完成。
- 不盲目跨分支整份覆盖AGENTS/GS，不借统一文档带入另一分支业务逻辑。

### 16.3 过渡期兼容规则

1. 新页只用唯一Astryx出口、已注册模板/组合；不能导入legacy。
2. 旧页只有在route-waves列明时可继续原renderer；允许必要缺陷修复，但不以旧底座创建新页/新基础件。
3. 已迁页面不能主表Astryx、弹窗和分页偷偷legacy。跨页SystemDialog/图片/附件宿主也要归属。
4. 正常验收推进时，legacy登记范围应逐波减少，不得新增业务消费者。已批准回退是唯一允许范围回增的情形：必须恢复相应legacy登记，将页面移出“已迁移/旧层已退出”，记录回退原因、负责人和重迁wave；回退页面继续计入未完成分母。新增盘点遗漏须如实登记并分配同轮归属，不能隐藏欠项。
5. 稳定业务组合可以保留；临时旧层必须在W6退出，两者不能互换标签。

### 16.4 主题与CSS过渡的实证要求

第一批必须交出以下证据，再选择实际过渡方式：

- root Theme写入/清理哪些html属性，谁唯一拥有mode/theme。
- 新CSS、生成主题、旧CSS的层叠和实际变量作用范围。
- 原生modal与新portal/Toast的主题继承、z-order、inert/focus行为。
- 首次加载、站内切换、懒加载模块和卸载后的样式稳定性。
- 旧页代表场景是否被根字体/默认元素规则意外影响。
- 新模式不能由“哪条懒路由先挂Theme”决定全站效果。

**不在W1全站直接导入reset.css重置所有元素。** 如某条规范化规则确为所需，给出精确来源、范围和回归证据；最终是否用完整官方reset也要在其影响可验证时决定。全套Astryx的关键是唯一基础组件/主题所有权，不是无条件重置整个DOM。[O-theme-source][O-reset][D-main]

### 16.5 回退方案

- 每波保留原批准版本与完整契约，不只留一张截图。
- 已迁稳定页面优先回上一个通过的Astryx版本，避免回到长期双底座。
- 过渡期必要时按完整页面/能力批次回原版本，保原业务数据与接口；状态回到“未迁完成”，同步登记原因/修复归属。
- 涉及非破坏性数据契约增量，旧消费者继续兼容；UI回退不撤销业务事实、角色授权或历史事件。
- 不用用户可见“旧版/新版”长期切换作为收尾；现cockpitAstryx off等旧试点路径最终退出正式运行图。
- 不以删入口/禁用按钮/隐藏字段“回退成功”。

## 17. 自动检查与浏览器验收计划

### 17.1 自动检查放进既有治理，不再造重复全量门禁

下列是拟增加/完善的检查职责，不冒称仓库已有同名命令：

| 检查 | 能证明什么 | 不能证明什么 |
|---|---|---|
| Rule ID/引用完整性 | 每个规则只定义一次；组件/页面/案例/测试有对应ID；旧条款有明确归属 | 规则本身业务正确 |
| import/API白名单 | 已迁页无第二UI库、无legacy/内部Astryx import、无已知伪props | 真按钮到正确订单 |
| 统一样式所有权 | 页面无私有基础字号/色板/按钮/弹层CSS；允许集中token/组合 | 所有像素自动正确 |
| 真实route/能力覆盖 | App实际路由/工作区/弹层/角色变体与manifest差异 | 所有角色都真实运行过 |
| 字段/条件/身份契约 | 迁移前后原字段、显隐条件、ID/round/scope绑定无无授权增删 | 后端生产数据完整性 |
| 状态断言 | 空/错/无权/未知/部分、0/负数等分支明确 | 现场所有网络故障已测 |
| 数据分页反例 | 资格过滤、total与目标页、版本变化、旧cursor契约 | 本轮已修好后端 |
| 构建资源对照 | JS/CSS/字体/locale/chunk变化、旧CSS运行依赖退出 | 一定更快；仍要浏览器测 |
| 证据状态检查 | API/源码/历史/运行/批准不混淆，未测有原因 | 用户已批准未读图 |

静态检查按运行时可达import图和实际CSS owner判断；历史文档、旧测试快照出现legacy字样，不应为了“字符串清零”被删除。

### 17.2 复用已有准确测试入口

按改动风险复用，不把所有小改都跑一整套无关业务链：

- tests/acceptance/searchable-select-browser.mjs
- tests/acceptance/platform-feedback-browser.mjs
- tests/acceptance/m01-cockpit-home-native-browser.ts
- tests/integration/m01-cockpit-home-native-browser-postgres.test.ts
- tests/integration/m01-journey-performance-postgres.test.ts
- tests/unit/cockpit-home.test.ts、cockpit-detail.test.ts、journey-visual-progress.test.ts
- tests/unit/list-pagination.test.ts、todo-list-pagination.test.ts
- tests/unit/system-dialog.test.ts、receiving-dialog.test.ts
- tests/unit/platform-feedback-recovery.test.ts
- tests/unit/n02-mobile-form-control-font-size.test.ts
- tests/unit/order-detail-information-architecture.test.ts
- tests/unit/workflow-state-visual-contract.test.ts
- 既有v1-prelaunch-performance-pr10/11/12相应用例。

这些路径存在且已读取清单；**规范交付时没有执行它们**。涉及SQL/查询改动，复用现有隔离测试并补PostgreSQL13.23定向回归，不另开索引PR。

### 17.3 浏览器验收要同时证明五件事

1. **信息守恒：** 逐事实ID/条件/格式对照，数量/金额/日期/分母与原模型一致。
2. **动作等价：** 原任务入口、返回、焦点、草稿、提交、权限拒绝、下载都真实走通。
3. **几何可读：** 同字号、完整文字、无相交/裁切、轨内%、对齐；使用真实字体和实际视口。
4. **组件来源：** 运行DOM/导入图能证明使用官方原件或登记组合/扩展；不是只换类名。
5. **性能不回退：** 原请求/读取/懒加载/资源行为与用户等待都对照，不只看网络某一个总时长。

原生运行截图记录SHA、浏览器、视口、zoom/DPR、字体加载、角色类型、订单/版本、业务时钟。截图可用于同场景差异；静态生成图与离线HTML不得升级为原生运行证据。原最终图缺失时，先建立“迁移前当前实现”的R/V基线并明确其身份；不能自动叫Eric最终定稿。

### 17.4 操作步数的计算

逐任务记录从同一起点到同一目标的必要主动操作：点击、键盘确认、菜单展开、切Tab、滚动/寻找是否明显增加。比较的是实际任务，不是“按钮个数”。

- 单任务船样、生产本单、收货详情、节点办理、凭证预览、返回原页等原直接路径不得增加必要步骤。
- 默认current展开不能变多点一次。
- 原可见字段不能因规范化强制打开另一窗才能读。
- 首页首PO+另N展开是明确批准例外，单独登记；不扩散。
- 现已有合法确认/安全约束不能为了减少步数删除。

### 17.5 性能验收设计：只在Acceptance或隔离环境

**本轮不执行；以下是未来验收计划，非实测结果。**

对核心两页和每类模板的代表复杂消费者，固定同账号、同数据/订单、同业务时钟、同浏览器与网络条件，配对记录：

- 首次打开：资源取得、CSS/字体ready、首批业务请求、首个可用区域。
- 站内切换：点击→路由→资源→关键请求→内容可操作。
- 详情与小窗：关键内容与历史/附件分段，错误不互锁。
- 返回、搜索、翻页：请求数/字节、服务端读取/装配（有原证据时）、渲染/布局、焦点与滚动。

建议先做每个重要代表场景3组首次打开、5组暖操作的配对样本；这是取样建议，**小样本只报原始值、中位数和范围，不包装成稳定p95**。仅在差异超出同环境波动或发现具体风险时增加样本；简单控件变更复用所属代表场景，不重复全站压测。

硬性行为标准：

- 不新增重复业务请求或逐行查库/查接口。
- 不为分页/跳页拉全量，不把客户端分页套到服务端大集合。
- 不解除原history/attachments的lazy，不使原lazy模块被公共barrel静态拉进首页。
- 中文只装必要locale，不因组件迁移新增无关字体下载；无样式首帧和字体后到造成的错排必须处理。
- 业务控制器、查询资格、权限、数量、风险、排序与SLA不变。
- 新主题/组件带来的资源差异必须以实际构建和浏览器数据说明；不能凭“tree shaking”“官方组件”宣布无损。
- 若用户体感指标超过同场景原基线与实测波动范围，先定位并修复后再验；不能把另一API优化收益抵消UI自身的退化。

过去船样2.17秒任务接口、约0.5秒历史等待，以及座舱10A响应/翻页与10B服务端装配，仍分别归原性能方案验收；全站UI迁移不合并这些责任，也不冒充本轮新结果。

## 18. 什么时候才算真正“全套 Astryx”

以下全部成立才能收口，不能用文档数量、import数量或两张截图替代：

1. **规范入口唯一：** AGENTS/README/索引指向同一主MD；旧冲突条款有明确替代/归档，不再并行行权。
2. **默认做法唯一：** 所有新页只用一个固定Astryx版本、一个主题、一个正式出口与注册模板。
3. **实际业务覆盖完整：** 每个可达路由、query工作区、角色只读分支、弹层、历史、打印/导出、失败恢复都有归属和验收。
4. **基础件来源闭合：** 运行中的每个业务控件属于官方原件、已批准统一组合或已批准集中扩展；没有第二UI库或复制旧基础renderer。
5. **旧运行路径退出：** legacy导入/基础CSS/token owner/试点off回退不再被正式入口消费。归档证据允许保留。
6. **信息与权限守恒：** 原字段、期限、日期、±天数、进度分母、数量/金额、角色与scope均未被组件迁移改写。
7. **交互等价：** 原真实入口、current展开、返回、草稿、下载与必要步骤符合页面契约。
8. **全系统分页真实完成：** 含私有分页与SLA历史的所有消费者保留原动作、查询和浏览范围；按 DXUI-PAGE-005 逐页验收。订单单据至少21条，续读后前20条完整保留。
9. **原生浏览器证据完整：** 中文、长文本、键盘/IME、窄屏/触屏、图像与焦点通过；缺批准图的部分诚实标未核。
10. **性能通过：** 保既有读取与懒加载治理，没有用删字段/权限放宽/算法改变换速度，实测无未解释回退。
11. **迁移欠项清零：** 临时legacy豁免为0；稳定业务组合不算欠项，但有唯一owner和测试。
12. **实际交付分支生效：** 最终交付运行版本包含迁移，不能只在研究分支/试点环境完成。

建议覆盖表使用“未盘点、已盘点、待能力、待验、已验、旧层已退出”这些明确状态，不用主观“完成90%”。真实coverage分母必须来自本轮route/能力manifest，旧审计数字不复用。

## 19. PR 验收清单

本清单是方案内容，不代表本轮创建PR或执行检查。

- [ ] 记录真实base/head、规范版本、规则ID、目标页面/组件与排除范围。
- [ ] 官方import和props来自固定0.7.16真实export/type；无猜名称/参数、无any强行绕过。
- [ ] 新消费者只用唯一Astryx出口；已迁能力无未登记legacy或第二UI库。
- [ ] 原字段逐项保留；无私增字段；条件性期限/数量/责任/日期不丢。
- [ ] 原权限、业务资格、原数量/金额、进度分母、风险、排序、SLA与时钟不变。
- [ ] 原真实入口和record/order/task/scope/round匹配；站内跳转和返回保留。
- [ ] 默认展开/原可见信息/必要操作步骤通过；多PO展开例外未扩散。
- [ ] 加载、空、无结果、失败、无权、未知、部分、过期响应与提交结果未知有独立验收。
- [ ] 中文长标签、完整日期、±差异、字体同级、冒号、对齐/裁切/轨内%有原生证据。
- [ ] 键盘/IME/触屏/窄屏、弹层ESC和焦点、附件原授权路径通过。
- [ ] 分页先权限/资格后取页；有total的页面与目标页同集合、同快照；游标、追加和新增版本按原浏览范围处理。原跳页能力保留，原逐页/续读页面只显示原动作；附 SLA 跳页及订单单据21条追加验收。
- [ ] #1073仍是原整单查看与收货资格；厂权限账号不转成部分PO小窗；未收超收不抵消。
- [ ] 原历史/附件lazy、请求合并、去重、模块拆包不退；资源与用户等待有对照。
- [ ] 数据查询变化有既有隔离用例及PG13.23定向回归；没有另开索引PR。
- [ ] 原图/当前运行/静态稿/源码/PR描述的证据身份分清；未测/未核/失败不写通过。
- [ ] 原组件/CSS/文档规则引用移除或准确登记退出批次；没有新增长期双轨。
- [ ] 回退粒度、可恢复版本、兼容消费者和退出条件明确。
- [ ] 按既有AGENTS治理执行所需验证，无额外重复全量门禁。
## 20. 文档落地与验收顺序

在同一个纯文档变更中接通仓库 AGENTS.md、README 和 UI 索引；每条旧规则先记录“原路径、原段、新 ID、适用范围、保留/替代/归档”，找不到继承目标不删除。目标分支分别核对，不靠跨分支覆盖工程政策。先核规范入口和条款唯一性，再实施自动检查；先只检查新引入或本次触达范围，清理旧层时再升级为全站强制。本次文档变更接通规范与文档入口。自动检查与页面实现按各自的变更记录确认。

- 第一批可自动拦截：未经允许的 UI 依赖、已迁路由引用旧基础层、新页未在目录登记、硬编码违规和断掉的规则引用。
- 必须用浏览器判定：日期字号及溢出、老页未被新主题污染、原入口可点与焦点恢复、跳页非法请求为零、同条件下性能不回退。
- 管理座舱首页与详情：获准离线风格原型 [Library 原包](https://chatgpt.com/library?file_id=libfile_fde3_f-c545dbf1c5a88191a52302a9485a9851_c8d3bf5d609c8191bce6411a30e94d44&account_id=personal)，11 月 19 日确认；不把该包当作运行态 PNG 或签收依据。尚未绑定最终运行图的尺寸字段标待核，不编一个默认值覆盖原页。

## 固定证据链接

[D-access]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/api/src/production-platform/access-policy.ts
[D-analysis-gs]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/docs/requirements/business-analysis-limited-ui-golden-source-v1.0.md
[D-app]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/App.tsx
[D-astryx-adapter]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-astryx.tsx
[D-cockpit]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/digital-journey-cockpit.tsx
[D-current-summary]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-current-summary.tsx
[D-date]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-date.tsx
[D-detail]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-detail.tsx
[D-detail-css]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-detail-r5.css
[D-difference]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-difference-days.ts
[D-document-editor]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/document-editor.tsx
[D-documents]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/docs/requirements/cockpit-documents-v1.0.md
[D-domain]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/docs/architecture/business-module-boundaries.md
[D-fact-links]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-home-fact-links.tsx
[D-feedback]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/tests/unit/platform-feedback-recovery.test.ts
[D-foreground]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/foreground-loading.tsx
[D-framework]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-framework-nodes.tsx
[D-home]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-home.tsx
[D-home-css]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-home-r5.css
[D-home-facts]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/api/src/production-platform/cockpit-home-facts.ts
[D-home-progress]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-home-progress.tsx
[D-lazy-history]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/lazy-history-details.tsx
[D-live-search]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/use-live-search.ts
[D-main]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/main.tsx
[D-main-package]: https://github.com/lizhonghao31-crypto/dx-rework/blob/b3113e5c55b2b3bcbb79b53be8382161b9414688/apps/web/package.json
[D-milestones]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-milestones.tsx
[D-modules]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/platform-modules.ts
[D-native-test]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/tests/integration/m01-cockpit-home-native-browser-postgres.test.ts
[D-node-dates]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-node-dates.tsx
[D-package]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/package.json
[D-pr1050]: https://github.com/lizhonghao31-crypto/dx-rework/pull/1050
[D-pr1054]: https://github.com/lizhonghao31-crypto/dx-rework/pull/1054
[D-pr1056]: https://github.com/lizhonghao31-crypto/dx-rework/pull/1056
[D-pr1072]: https://github.com/lizhonghao31-crypto/dx-rework/pull/1072
[D-pr1073]: https://github.com/lizhonghao31-crypto/dx-rework/pull/1073
[D-production]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/production-display-workspace.tsx
[D-receipt-dialog]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-receipt-dialog.tsx
[D-receipt-facts]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/api/src/production-platform/cockpit-receipt-facts.ts
[D-receipt-service]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/api/src/production-platform/cockpit-receipt-service.ts
[D-receiving-summary]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/api/src/production-platform/receiving-summary.ts
[D-record-link]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/cockpit-record-link.tsx
[D-samples]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/sample-workspace-page.tsx
[D-search-select]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/search-select.tsx
[D-sla-history]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/sla-history-workspace.tsx
[D-system-dialog]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/system-dialog.tsx
[D-todo]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/my-todos-page.tsx
[D-tokens]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/packages/ui/src/tokens.css
[D-tools-attachments]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/api/src/tools/attachments.ts
[D-tools-routes]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/api/src/tools/routes.ts
[D-ui-gs]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/docs/requirements/rework-ui-golden-source-v1.0.md
[D-ui-index]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/packages/ui/src/index.tsx
[D-upload]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/attachment-upload.ts
[D-upload-recovery]: https://github.com/lizhonghao31-crypto/dx-rework/blob/1d163c5e523b09dc455faece3f089695cf59aa8c/apps/web/src/attachment-upload-recovery.ts
[O-alertdialog]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/AlertDialog/AlertDialog.doc.mjs
[O-badge]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Badge/Badge.doc.mjs
[O-badge-source]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Badge/Badge.tsx
[O-banner]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Banner/Banner.doc.mjs
[O-bottomsheet]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/BottomSheet/BottomSheet.doc.mjs
[O-button]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Button/Button.doc.mjs
[O-charts]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/charts/README.md
[O-collapsible]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Collapsible/Collapsible.doc.mjs
[O-dateinput]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/DateInput/DateInput.doc.mjs
[O-dialog]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Dialog/Dialog.doc.mjs
[O-drawer]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Drawer/Drawer.doc.mjs
[O-fieldstatus]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/FieldStatus/FieldStatus.doc.mjs
[O-file]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/FileInput/FileInput.doc.mjs
[O-focus]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/utils/focusOutline.stylex.ts
[O-form]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/FormLayout/FormLayout.doc.mjs
[O-grid]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Grid/Grid.doc.mjs
[O-heading]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Text/Heading.doc.mjs
[O-i18n]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/i18n/InternationalizationProvider.doc.mjs
[O-icon]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Icon/Icon.doc.mjs
[O-iconbutton]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/IconButton/IconButton.doc.mjs
[O-ime]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/utils/ime.ts
[O-layer]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Layer/Layer.doc.mjs
[O-lightbox]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Lightbox/Lightbox.doc.mjs
[O-link]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Link/Link.doc.mjs
[O-metadata]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/MetadataList/MetadataList.doc.mjs
[O-multiselector]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/MultiSelector/MultiSelector.doc.mjs
[O-number]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/NumberInput/NumberInput.doc.mjs
[O-package]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/package.json
[O-pagination]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Pagination/Pagination.doc.mjs
[O-popover]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Popover/Popover.doc.mjs
[O-progress]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/ProgressBar/ProgressBar.doc.mjs
[O-progress-source]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/ProgressBar/ProgressBar.tsx
[O-readme]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/README.md
[O-reset]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/reset.css
[O-scroll]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/ScrollableArea/ScrollableArea.doc.mjs
[O-selector]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Selector/Selector.doc.mjs
[O-skeleton]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Skeleton/Skeleton.doc.mjs
[O-spinner]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Spinner/Spinner.doc.mjs
[O-stack]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Stack/Stack.doc.mjs
[O-statusdot]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/StatusDot/StatusDot.doc.mjs
[O-step]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Stepper/Step.doc.mjs
[O-styling]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/cli/assets/docs/tree/styling-basics.doc.mjs
[O-styling-advanced]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/cli/assets/docs/tree/styling-advanced.doc.mjs
[O-switch]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Switch/Switch.doc.mjs
[O-table]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Table/Table.doc.mjs
[O-table-base]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Table/BaseTable.tsx
[O-table-header]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Table/TableHeaderCell.tsx
[O-table-pagination]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Table/plugins/pagination/useTablePagination.tsx
[O-table-types]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Table/types.ts
[O-table-virtual]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Table/useTableRowsVirtualization.doc.mjs
[O-text]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Text/Text.doc.mjs
[O-textinput]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/TextInput/TextInput.doc.mjs
[O-theme]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/theme/Theme.doc.mjs
[O-theme-source]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/theme/Theme.tsx
[O-timestamp]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Timestamp/Timestamp.doc.mjs
[O-toast]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Toast/Toast.doc.mjs
[O-tokens]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/theme/tokens.stylex.ts
[O-typeahead]: https://github.com/meta/astryx/blob/5051ea96a35307183e9f3fab7fadcc7b0d649e45/packages/core/src/Typeahead/Typeahead.doc.mjs
