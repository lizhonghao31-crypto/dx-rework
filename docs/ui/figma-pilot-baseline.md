# UI Pilot 基线与 Figma 状态

更新时间：2026-07-31  
Run ID：`dx-ui-pilot-20260731`

## 1. Figma Golden Source

- UI 基础库：[达兴企业 UI 基础库 · Pilot](https://www.figma.com/design/kgn6PGlRc10OaYD5xazmZd)
- 产品设计：[内部计件返工系统 · Product](https://www.figma.com/design/UXYXB0VamHidRLy7xBFLV7)

基础变量与组件只在基础库定义；业务页面只在 Product 文件组合和验收。

## 2. 设计原则

1. 业务可读性和操作效率优先。
2. 延续 ERP 的 Slate 中性色、Indigo 主操作色及绿/黄/红状态语义。
3. Soft UI 只用于表面层级，不用于弱化文字、状态或操作按钮。
4. 不整体导入社区 UI Kit；可参考结构、状态和无障碍处理。
5. 设计 token 与未来代码 CSS 变量使用 `--dx-` 前缀，减少接入 ERP 时的命名冲突。
6. 管理层共用完整信息座舱，避免人为制造信息分区。

## 3. Phase 0 决策

### 直接复用

- ERP 的颜色语义和信息密度经验；
- React/Vite/Web 的实现方向；
- 桌面管理、移动操作的双端思路。

### 重新建立

- 正式设计 token；
- 可复用组件 API；
- 中文业务字体层级；
- 对比度、触控尺寸和状态规范。

### 不直接复用

- 巨型页面文件；
- 大量超小字号；
- 只靠阴影表达状态；
- 社区 UI Kit 的生产依赖。

## 4. Phase 1 锁定范围

### 变量集合

- `Primitives`
- `Color`
- `Dimensions`
- `Typography`

Figma Starter 方案只支持单模式，本期使用 `Default`。当前 ERP 与返工试点均为浅色界面，暂不为暗色模式升级付费或增加复杂度。

### 尺寸

- Spacing：4、8、12、16、20、24、32
- Radius：8、12、16、24、Full

### 字体

优先使用 Figma 已核验存在的 `Noto Sans SC`：

- Regular
- Medium
- Bold

目标样式：

- Display/Management KPI
- Heading/Page
- Heading/Section
- Body/Default
- Body/Compact
- Label/Default
- Caption/Default
- Caption/Strong

### 阴影

- Elevation/Surface
- Elevation/Card
- Elevation/Floating
- Inset/Control

## 5. 第一批组件

依赖顺序如下：

1. Button / Icon Button
2. Input / Select / Textarea
3. Status Badge
4. KPI Card
5. Search & Filter
6. Desktop Table / Mobile Record Card
7. Process Timeline
8. Approval Action Bar
9. Attachment Evidence
10. Audit Log Row
11. Empty / Loading / Error / No Access
12. Desktop Sidebar / Mobile Navigation

组件必须绑定设计变量，不允许为每个页面复制硬编码样式。

## 6. 第一批产品页面

1. 李总、伍云峰、张文豪共用的全量管理座舱；
2. 李同生的中层工作台；
3. 基础员工个人待办；
4. 返工发起、核实、审批、执行、完成；
5. 返工详情、流程时间线、附件与审计日志。

## 7. 当前执行状态

已完成：

- 4 个变量集合；
- 35 个基础色变量；
- 26 个语义颜色变量；
- 所有已创建变量均设置明确 scopes、WEB code syntax 和幂等标记。

未完成：

- 成功/警告/危险/信息状态语义变量；
- Dimensions 与 Typography 变量；
- 8 个文字样式；
- 4 个阴影样式；
- Phase 1 完整验证。

原因：Figma Starter 方案触发 MCP 调用上限。失败调用为原子失败，未产生半写入对象；恢复后从 `P1.c status/success` 继续。
