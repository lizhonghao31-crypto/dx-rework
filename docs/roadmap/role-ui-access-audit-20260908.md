# 角色权限、页面可用性专项审查 · 2026-09-08

## 当前授权与优先级

业务负责人要求先解决角色权限、功能开放、接口兼容与布局污染，再实施此前供应商与看板优化。
供应商新增审批已确认：生产管理或老板任一方通过即生效，不建设两级串行审批。
本轮开始日期无法选择属于功能阻断，不按纯美化处理。

## 本次施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 944133b173988a32182480153914cfee36b9aaaf
- working branch: fix/role-aware-filter-layout
- task scope: 修复可选导出按钮缺席时回货开始日期被挤压及返工筛选区控件重叠。
- allowed files: apps/web/src/role-layout-safety.css、apps/web/src/ui-polish.css、tests/unit/role-filter-layout-safety.test.ts、本文件。
- forbidden files: 其他产品源文件、数据库迁移、角色授权、订单数据、金额数量算法、钉钉配置、部署与CI拓扑。
- Golden Source: 上述当前main。ui-polish.css原blob为51993f8f8f4ddad818a6938a08f9764b7c04a4f0，原内容完整保留，仅增加定向CSS导入。
- 修改方式: 增量CSS；不改原类名、控件配色、原生日期输入、min/max和请求参数。

## 已定位的问题

| 问题 | 源码事实 | 状态 |
|---|---|---|
| 回货开始日期与结束日期重叠、开始日期点击被截获 | order-board-page.css固定首列44px供导出使用；order-board-page.tsx按canExport条件渲染按钮，无按钮时开始日期占据该列 | 已由前序布局PR修复；Acceptance需复验 |
| 返工筛选框重叠 | rework-query-mobile.css桌面固定列最小宽度；共享dx-field默认最小250px；页面可用宽度还要扣除侧栏 | 已由前序布局PR修复；Acceptance需复验 |
| 财务可见返工列表但详情拒绝 | 列表按dashboard/report能力读取；详情broadBusinessReader此前不含finance_director，finance_read仍要求该订单已有工资记录 | 权限治理02已由#440修复并合并；事后Codex Review未发现major issue；finance_read范围未扩大 |
| 财务总监看不到样衣 | platform-modules、App路由、sample-authority与sample-analysis-model此前的角色白名单不含finance_director | 权限治理01已由#439修复并合并；仅开放sample:view_basic / sample:view_finance / sample:view_audit，写权限保持禁止；Acceptance待复验 |
| 人员权限后台模块分类滞后 | platform-access仅识别订单返工、外发定价&选厂、实时生产看板、平台管理；未识别供应商中心和样衣管理；仓管receiving能力未归入返工，生产管理/订单跟单的生产看板角色条件也未进入人员权限模块分类 | 权限治理03施工中：只修权限后台的模块归类、筛选和显示，不新增任何真实业务权限 |
| 外发历史报nextCursor及page字段不匹配 | 当前main的SourcingCaseListResponseSchema已使用page/pageSize/totalCount/totalPages；截图客户端仍期待nextCursor | 待核对实际部署/静态资源/浏览器会话版本；尚不能归因于数据库或权限 |

## 本次修复

回货标题与筛选按实际内容宽度换行；导出按钮存在时占自己的44px，不存在时不保留位置假设。标签与输入框明确可收缩且边框纳入盒宽；空操作容器不占位。不通过z-index、遮盖、关闭点击或增加角色权限规避问题。

返工桌面筛选改为依据内容宽度自动分列，日期范围占两个标准字段位；共享InsetField内层输入不再绘制第二层满尺寸外框。手机原三列筛选规则保留；回货手机仍为两列字段。

优势：修复可见性裁剪后的布局缺陷，同时保留业务权限与日期规则。
风险：不同浏览器原生日期外观存在差异；共享CSS导入必须经构建及实际页面验收，不把源码字符串测试当作视觉验收。
回滚：revert本PR，恢复原ui-polish.css；无数据库回滚或数据变更。

## 已取得的局部证据

在隔离Chromium夹具中，按当前源码相关布局声明与筛选DOM复现：修复前开始日期的鼠标命中落到结束日期，且两个输入框矩形相交。
修复后验证360x800、390x844、768x1024、1024x768、1280x800、1440x1024，分别组合导出显示/隐藏、收货入口显示/隐藏，共24种组合。各控件矩形无相交，左中右点击命中正确，开始日期与结束日期可分别改为2026-09-01和2026-09-10。

边界：以上是隔离布局/原生输入夹具，不是真实账号UAT，不包含生产API或Windows钉钉原生弹层验收。新增5项结构回归交由当前PR Head的Full Gate验证；本地未安装完整项目依赖，未声称本地全套lint、build、unit通过。线上未部署，不能标记已解决。

## 2026-09-09 权限治理02

- base: `main@2a73f618235020d412370d9f60f80335ab0d7d42`
- branch: `fix/acceptance-audit-finance-rework-detail`
- 目标：修复财务总监能进入返工模块/列表但任意尚未生成工资事实的返工详情被403拒绝。
- 修复边界：`finance_director` 获得返工业务详情全量**只读**准入，与其现有全局财务查看和管理列表范围一致；不把 `finance_read` 从工资事实范围提升为全量详情，不新增角色 capability，不修改任何业务写动作、状态机、金额、Todo、真实人员角色或Root行为。
- 附件读取继续复用详情授权链；只有能查看对应返工单时才允许下载绑定附件。
- 验收：财务总监在无工资事实订单上详情允许；普通 `finance_read` 同一订单仍拒绝，有工资事实后仍允许；Full Gate exact Head全绿后合并。
- 结果：#440 已合并；最终合并 commit `90119cb99eec3b6203ca3d8af9b3fd780828662a` 的事后Codex Review未发现major issue。

## 2026-09-09 权限治理03

- base: `main@90119cb99eec3b6203ca3d8af9b3fd780828662a`
- branch: `fix/acceptance-audit-employee-module-classification`
- 目标：把“人员与权限”恢复为当前平台真实模块结构的管理入口，避免管理员看到的角色/模块归类落后于系统实际入口。
- 当前平台分类固定为：订单返工、外发定价&选厂、供应商中心、实时生产看板、样衣管理、平台管理。
- 归类只读取既有role/capability事实：`supplier_profile:*`归供应商中心，`sample:*`归样衣管理，`receiving:*`和现有返工报表能力归订单返工；生产管理/订单跟单只有在现有`sourcing:view`条件满足时才归实时生产看板，保持与正式`canAccessProduction`角色条件一致。
- Root与老板的后台展示同步当前全部模块；人员模块筛选新增供应商中心和样衣管理。
- **不新增、撤销或修改任何role_capabilities，不修改员工角色，不改变正式路由/Service/数据库鉴权。** 这是管理后台分类一致性修复，不是业务提权PR。
- 验收：角色模块标签、模块筛选、Root/老板展示、仓管返工归类、订单跟单/生产管理生产看板归类、样衣/供应商角色归类均有定向回归；Full Gate后执行一次Codex Review，由Work自行处理finding。

## 后续专项与结束条件

1. 权限一致性：覆盖每个已启用业务角色，逐项检查菜单、路由、列表范围、详情、字段/附件、写入、导出、待办深链及撤权后的会话。财务总监新增样衣基本/财务/审计查看范围，不默认为新增、调价、交接、处置审批或Root权限；独立样衣财务现有能力保留。
2. 界面一致性：覆盖无按钮、单按钮、多按钮、多角色叠加、长名称/大数、空/错误/加载/禁用状态，核查侧栏后的真实内容宽度。不得只测Root或仅以设备像素比替代浏览器缩放测试。
3. 接口与会话版本：核对前端静态资源与API契约来自一致发布；保留校验，不用忽略未知字段或吞掉错误恢复空列表。
4. 真账号与负向验收：有权角色可正常进入并完成本职操作；无权角色直接访问链接/API仍被拒绝；普通工人、仓管不可取得达兴成本价；Root既有调试能力不变。
5. 原四项优化仍暂停：供应商串页与分工、新增审批、分析面板收口、测试订单删除。1222及其他生产订单本PR不读取、不修改、不清理。

本专项完成需提供逐项实际结果与未通过项；当前权限治理03只处理人员权限后台模块分类一致性，不代表全系统审查完成。