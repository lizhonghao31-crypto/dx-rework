# 工作台 v11.5 C1 施工与验收记录

基线为 `release/digital-production-v1@5865c81247b163649cb4ca017a833d49704c8ecf`。范围为签定的 v11.5 §1、V01、V02、V07 公共部分。唯一现行规范为 [达兴 Astryx UI 规范 1.0](../ui/ASTRYX_UI_SPEC.md)。

## 规则核对

| 文件和条款 | 原要求或风险 | 本次处理 | 对照页面 |
|---|---|---|---|
| 主规范 T02、§5 组合表、DXUI-PAGE-001 | 统一严格跳页为默认组件，容易给原游标页面新增动作 | 统一外观，逐页、跳页和追加续读按原契约 | 所有既有分页消费者 |
| 主规范 DXUI-PAGE-005、§7.3 | 原游标最终要补精确跳页服务端能力，缺跳页视作未完成 | 替换为原能力不增不减，保历史浏览上界与原刷新 | SLA 历史标准、订单单据历史 |
| 主规范 §12.2、W3、W5、§18–19 | 旧游标需改接口，验收只以精确跳页为完成 | 兼容真实游标与已加载集合，既有跳页照常验证 | 多页、首末页、无分页、追加续读 |
| 主规范 DXUI-LAYER-005、008 | 确认和结构化字段纠错没有明确共用入口 | 原 Promise 队列承接 AlertDialog 和 Dialog，保留旧 prompt 的空值与取消语义 | 工作台建单、预下单转正式确认 |
| 返工 UI Golden Source、§1 | 旧段落称 `@dx-rework/ui` 是唯一公共 UI 所有者 | 标记已废止并链接准确现行规则，保旧页和现有业务契约 | 返工旧页面、外发旧入口、实时看板 |
| 分析业务口径 §设置（Final10 版本2 §8） | 旧记录写历史标准为游标分页 | 明确已经废止的施工口径，保已发布标准不可变、真实操作者及原授权 | SLA 历史标准 |
| AGENTS.md、README、旧控件盘点 | AGENTS 已指向主规范。README 的 Golden Source 项是业务及代码来源。2026-09-21 盘点是历史覆盖记录 | 保持唯一现行 UI 规范及原材料引用 | 首次接手、后续 PR 验收 |

## 样板与例外

- 已确认订单现有长表使用固定 `@astryxdesign/core@0.7.16`。现用的 Button、TextInput、Selector、DateInput、CheckboxInput、Stepper/Step、FormLayout 沿用原状态与字段。文件选择与已保存附件保现有准备、预览和保存流程。
- 维护方为设计开发工作台。原单据正文、尺寸和精确数量矩阵保 DocumentField、原表格和打印机制。原生只读标识字段有显式 class。原日期最小值保原生选择器约束，原时长审批校验仍从原流程。Legacy CSS 只管理旧创建路由或明确标识的原单据字段。
- 原确认与字符串输入保共用队列。已确认步骤的字段纠错沿现有定位，选中材料后展开原材料区。原任务、权限、写命令和回执恢复的回归仍属于对应旧业务套件。
- 读取反馈沿原「读取中，请稍候」及已有调度。原洗水组件、查询及业务入口未纳入本次改动。

## 分页实际调用点

以下为基线工作区内现有分页控制器及消费组件。列表的权限、筛选、排序、当前页和总数仍由原调用者提供。页面有原页码按钮时保留；以原游标继续读的目录保持追加或展开；原本没有分页的列表无需增加分页。

| 原组合 | 文件（`apps/web/src` 下） | 本次承接 |
|---|---|---|
| 原 ListPagination | `admin-console-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `auxiliary-catalog-dialog.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `auxiliary-catalog-history.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `bulk-task-workbench.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `customer-default-merchandisers.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `cutting-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `development-original-versions.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `digital-designer-workspace.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `digital-production-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `digital-production-tasks-panel.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `employee-access-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `external-responsibility-queue-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `frontline-task-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `master-data-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `my-todos-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `order-board-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `order-time-calculator.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `order-time-standard-editor.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `original-document-directory.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `own-factory-approval-queue-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `pattern-history-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `pattern-room-orders-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `production-analysis-panel.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `production-closure-ui.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `production-dashboard-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `production-reporting-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `receiving-analysis-panel.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `reporting/basic-rework-board.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `reporting/report-center-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `reporting/rework-query-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `reporting/workflow-queue-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `responsibility-queue-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `rework-data-sandbox-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `rework-flow-panel.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `sample-analysis-view.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `sample-disposal-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `sample-workspace-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `sla-independent-calculator.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `sla-order-application-panel.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `sla-settings-set-editor.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `sourcing-workspace-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `supplier-center-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `supplier-onboarding-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `task-workbench-sample.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `wages/wage-period-detail.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `wages/wage-period-list.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `work-analysis-panel.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 ListPagination | `workforce-master-data-page.tsx` | 保留原页码、跳页、前后页和原 total（有传时） |
| 原 UI Pagination | `bulk-pattern-workspace.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `cockpit-home.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `cockpit-timing-coverage.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `current-production-page.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `delivery-calendar-page.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `digital-analysis-page.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `digital-designer-workspace.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `digital-pattern-workspace.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `digital-production-workspaces.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `production-command-center-view.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `production-display-workspace.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 UI Pagination | `sla-history-workspace.tsx` | 保留原 total／页码、前后页及跳页 |
| 原 Astryx 控件组合 | `designer-related-originals.tsx` | 保留源 page／total 及原禁用、越界恢复和跳页 |
| 原 Astryx 控件组合 | `ie-processing-center.tsx` | 保留源 page／total 及原禁用、越界恢复和跳页 |
| 关联资料目录 | `cockpit-documents.tsx` | 原「读取下一页关联单据」按现有 cursor 追加 |
| 订单事实历史 | `cockpit-documents.tsx`、`cockpit-documents-production.ts` | 「读取更早记录」继续使用原 details、beforeId 及记录树 |
| 设计工作台原单目录 | `designer-related-originals.tsx` | 原「读取下一页关联单据」及授权快照继续追加 |
| 座舱操作记录 | `cockpit-operation-log.tsx` | 已有居中换行的原对话框续读区，保留原较大的按钮触控区、已加载条数、`cursor` 和 `asOf`；单据历史另验 |

## 实际验收

隔离浏览器确认的作业基线为相同版本、合成角色及相同尺寸，样板首步在 1165×747、1440×900 输入内框由 1px 变为 0，Astryx 外框保持 1px，字号 14px、行高 20px。原网格渲染顶对齐；没有把旧 CSS 文本声明当成已复现视觉缺陷。此为本地第一轮样板对照。

现有 Acceptance 版本接口核对到基线 SHA，schema 为 0301。实际运行的「生产管理设置 → 历史设置」由 OrderTimeStandardEditor 或原套件编辑器接入。带 `browseMaxVersion` 与 `browseToken` 的旧 SlaHistoryWorkspace 及其 API 仍在源码；当前路由是否实际走它，以现场请求为准。旧 API 的本地回归不能替代当前页面对照。

经 Eric 确认，先留齐改前现场证据，并对提交完成正常门禁与本地真实浏览器验证。合入发布分支后，按正式更新入口部署 Acceptance，再用同一合法账号、相同视口与记录对照。通过后推进下一 PR。项目隔离库证据和网站会话分别登记。

| 必验路径 | 验收记录 |
|---|---|
| V01 实际已确认订单复杂长表 | 同账号、同 TEST 订单、同主题，1165×747、1440×900、现场宽度及 200% 文字缩放，前后截图、计算样式与原显示证据 |
| V02 SLA「历史标准」 | 原 total、有效非相邻跳页、前后页、非法输入零请求；真实新增历史后，原浏览 token 和上界固定，原刷新纳入新版本 |
| V02 订单单据真实 21 条以上历史 | 固定同一 TEST 单。首批20条记录 ID／顺序不变，点「读取更早记录」读取第21条及其真实版本，留原游标、末端、重试和返回证据 |
| V02 原分页清单与非目标页 | 各调用者按其原有能力验证、保角色和原请求，另核大货洗水原入口 |

本 PR 只回退呈现层。相邻业务命令、原存量、角色和时效不因回退改变。
