# UI Pilot 基线与 Figma 状态

更新时间：2026-07-31  
Run ID：`dx-ui-pilot-20260731`

## 1. Figma Golden Source

- UI 基础库：[达兴企业 UI 基础库 · Pilot](https://www.figma.com/design/kgn6PGlRc10OaYD5xazmZd)
- 产品设计：[内部计件返工系统 · Product](https://www.figma.com/design/UXYXB0VamHidRLy7xBFLV7)

基础变量与通用组件只在基础库定义；业务页面只在 Product 文件组合和验收。V2 六页 Product 页面与五个通用组件均已完成设计核验，PR-01A 正在按该基线落地代码。

## 2. 设计原则

1. 业务可读性和操作效率优先。
2. 延续 ERP 的 Slate 中性色、Indigo 主操作色及绿/黄/红状态语义。
3. Soft UI 只用于表面层级，不用于弱化文字、状态或操作按钮。
4. 不整体导入社区 UI Kit；每个组件先扫描可复用资产，再决定复用或按本项目业务语义建立。
5. 设计 token 与未来代码 CSS 变量使用 `--dx-` 前缀，减少接入 ERP 时的命名冲突。
6. 李总、伍总、张文豪共享同一套完整管理信息界面；具体操作能力按职责控制并全程记录审计日志。
7. 状态不能只靠颜色表达，必须同时显示明确中文文字。

## 3. 设计系统基础

已完成并验证：

- 4 个变量集合：`Primitives`、`Color`、`Dimensions`、`Typography`；
- 102 个变量，其中包含背景、文字、操作、成功、警告、危险、信息、间距、圆角、描边、字号和行高；
- 8 个文字样式；
- 4 个阴影样式；
- `Noto Sans SC` 的 Regular、Medium、Bold 字体层级；
- Foundations 说明页：Color、Typography、Spacing & Radius、Elevation；
- 所有已创建变量和组件均带 Run ID、阶段和逻辑键，支持幂等续建和追溯。

当前仍保留单一 `Default` 模式。浅色模式符合 ERP 与返工试点现状；升级 Figma 后没有立即增加暗色模式，避免在无业务价值处扩大成本。

## 4. 已完成组件

### Button

- 节点：[Button Component Set](https://www.figma.com/design/kgn6PGlRc10OaYD5xazmZd?node-id=23-2)
- 24 个变体：`Size × Style × State`；
- Size：Small、Medium、Large；
- Style：Primary、Secondary；
- State：Default、Hover、Pressed、Disabled；
- 已绑定文字属性、颜色、间距、圆角、描边、字号、行高、字体家族和字重变量；
- 结构与视觉检查已通过，用户已确认。

### Status Badge

- 节点：[Status Badge Component Set](https://www.figma.com/design/kgn6PGlRc10OaYD5xazmZd?node-id=31-2)
- 10 个变体：`Size × Tone`；
- Size：Small、Medium；
- Tone：Neutral、Info、Success、Warning、Danger；
- 已绑定 `Label` 文字属性及全部视觉变量；
- 业务语义：草稿/未开始、处理中、已通过/已完成、待处理/临近超时、已驳回/扣款失败/已超时；
- 结构与视觉检查已通过，当前等待本轮产品确认。

## 5. 与集体计件规则的 UI 关系

已确认集体计件先形成组总额，再按该条记录的成员快照人数平均分摊。因此后续任务与工资页面必须同时展示：

- 集体计件标识；
- 组总额；
- 成员名单快照与人数；
- 当前用户个人分摊额；
- 管理/财务角色可下钻的完整个人分摊明细；
- 已锁定记录不可因后续成员变化而反算的提示。

金额除不尽时的尾差分配规则在工资导出功能开发前确认，不阻塞当前设计系统和页面骨架。

## 6. 下一步组件顺序

Status Badge 获得产品确认后，依赖顺序为：

1. Input / Select / Textarea；
2. KPI Card；
3. Search & Filter；
4. Desktop Table / Mobile Record Card；
5. Process Timeline；
6. Approval Action Bar；
7. Attachment Evidence；
8. Audit Log Row；
9. Empty / Loading / Error / No Access；
10. Desktop Sidebar / Mobile Navigation。

每个组件必须单独完成复用扫描、变量绑定、结构检查、视觉检查和用户检查点，不能批量生成后统一补验收。

## 7. 当前交付状态

- Figma 已升级，当前不存在 Starter 调用额度阻塞；
- 业务需求基线已通过，并新增集体计件平均分摊规则；
- Button、Status Badge、Navigation Item、KPI Instrument、Inset Field 已完成设计核验；
- 管理层共享座舱、李同生现场工作台、返工任务列表、返工详情与责任处理、品控发起返工、集体计件上数六页已完成 V2 设计核验；
- PR-01A 正在进行代码施工；浏览器截图、360px 溢出、键盘与完整 ARIA 仍须由浏览器 CI / 外部验收提供证据。
