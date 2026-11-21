# 分页放置点核对

与获批施工计划附录 A 逐项核对，源码接入 68 处。43 处使用通用分页，11 处沿用生产分页，14 处手写分页接入共享能力。下表记录源码检查；真实浏览器与 PostgreSQL 样本以本 PR 施工证据和 CI 检查记录为准。

| 文件 | 原入口 | 放置点 | 接入宿主 |
|---|---|---:|---|
| `admin-console-page.tsx` | /ui/admin、/ui/audit：审计日志、附件、代理授权、系统异常 | 4 | ListPagination |
| `cutting-page.tsx` | /ui/cutting 裁床实裁列表 | 1 | ListPagination |
| `employee-access-page.tsx` | /ui/employee-access 员工权限目录 | 1 | ListPagination |
| `external-responsibility-queue-page.tsx` | /ui/external-responsibilities 供应商扣款队列 | 1 | ListPagination |
| `frontline-task-page.tsx` | /ui/frontline/tasks 本人任务 | 1 | ListPagination |
| `master-data-page.tsx` | /ui/master-data：外发工艺、供应商兼容视图、公共工序 | 3 | ListPagination |
| `order-board-page.tsx` | /ui/orders 订单回货 | 1 | ListPagination |
| `own-factory-approval-queue-page.tsx` | /ui/own-factory-approvals 本厂承担审批 | 1 | ListPagination |
| `pattern-history-page.tsx` | /ui/pattern-room/history 历史记录 | 1 | ListPagination |
| `pattern-room-orders-page.tsx` | /ui/pattern-room/orders及板房嵌入：订单打板/杂事 | 1 | ListPagination |
| `production-analysis-panel.tsx` | 生产分析：供应商分组、订单明细 | 2 | ListPagination |
| `production-closure-ui.tsx` | 回货结案办理内预期回货选择列表 | 1 | ListPagination |
| `production-dashboard-page.tsx` | /ui/production-dashboard 原管理看板 | 1 | ListPagination |
| `production-reporting-page.tsx` | /ui/production-reporting 生产填报订单列表 | 1 | ListPagination |
| `receiving-analysis-panel.tsx` | 回货分析明细 | 1 | ListPagination |
| `reporting/basic-rework-board.tsx` | 返工基础信息看板 | 1 | ListPagination |
| `reporting/report-center-page.tsx` | /ui/reports 财务报表预览 | 1 | ListPagination |
| `reporting/rework-query-page.tsx` | /ui/tasks 返工查询 | 1 | ListPagination |
| `reporting/workflow-queue-page.tsx` | /ui/process-configuration、/ui/work-reporting、/ui/piecework/collective 的节点队列 | 1 | ListPagination |
| `responsibility-queue-page.tsx` | /ui/responsibility 待责任判定 | 1 | ListPagination |
| `rework-data-sandbox-page.tsx` | 返工数据沙盘明细 | 1 | ListPagination |
| `rework-flow-panel.tsx` | 流程等待分析 | 1 | ListPagination |
| `sample-analysis-view.tsx` | 样衣分析分组、样衣列表 | 2 | ListPagination |
| `sample-disposal-page.tsx` | 样衣详情/处置区：管理员归档、财务变更记录 | 2 | ListPagination |
| `sample-workspace-page.tsx` | /ui/samples、pending、disposed、amounts等模式；单件历史和主列表 | 2 | ListPagination |
| `sourcing-workspace-page.tsx` | /ui/sourcing、pending、history 外发列表 | 1 | ListPagination |
| `supplier-center-page.tsx` | /ui/suppliers目录、/ui/suppliers/manage维护 | 1 | ListPagination |
| `supplier-onboarding-page.tsx` | /ui/suppliers/requests 供应商申请 | 1 | ListPagination |
| `wages/wage-period-detail.tsx` | /ui/wages期间明细 | 1 | ListPagination |
| `wages/wage-period-list.tsx` | /ui/finance、/ui/wages：工人工资汇总、工资明细 | 2 | ListPagination |
| `work-analysis-panel.tsx` | 作业分析各kind明细 | 1 | ListPagination |
| `workforce-master-data-page.tsx` | /ui/people：内部工人、临时工 | 2 | ListPagination |
| `bulk-pattern-workspace.tsx` | /ui/digital-pattern-room?section=bulk 大货板房 | 1 | 生产 Pagination |
| `cockpit-home.tsx` | /ui/digital-cockpit 座舱首页（图3） | 1 | 生产 Pagination |
| `cockpit-timing-coverage.tsx` | 座舱时效待补充分组钻取 | 1 | 生产 Pagination |
| `current-production-page.tsx` | /ui/digital-analysis?view=production 当前生产/期间数量 | 1 | 生产 Pagination |
| `delivery-calendar-page.tsx` | 座舱交付点阵图日/月所选日/缺件PO明细 | 1 | 生产 Pagination |
| `digital-analysis-page.tsx` | /ui/digital-analysis 板房沙盘任务明细 | 1 | 生产 Pagination |
| `digital-designer-workspace.tsx` | /ui/digital-production?workspace=designer 设计师档案 | 1 | 生产 Pagination |
| `digital-pattern-workspace.tsx` | /ui/digital-pattern-room 开发完整任务列表/栏位查看全部 | 1 | 生产 Pagination |
| `digital-production-workspaces.tsx` | 数字生产产前/发厂列表宿主 | 1 | 生产 Pagination |
| `production-command-center-view.tsx` | LiveProductionCommandCenter兼容座舱呈现 | 1 | 生产 Pagination |
| `production-display-workspace.tsx` | /ui/production-dashboard?workspace=display及motherOrderId精确母单范围 | 1 | 生产 Pagination |
| `my-todos-page.tsx` | 我的待办独立页码窗口 | 1 | 已接入原分页宿主 |
| `auxiliary-catalog-dialog.tsx` | /ui/auxiliary-catalog及内嵌辅料目录 | 1 | 已接入原分页宿主 |
| `customer-default-merchandisers.tsx` | 客户默认跟单设置 | 1 | 已接入原分页宿主 |
| `digital-designer-workspace.tsx` | 开发草稿箱 | 1 | 已接入原分页宿主 |
| `digital-production-page.tsx` | 历史单关联开发来源 | 1 | 已接入原分页宿主 |
| `digital-production-tasks-panel.tsx` | 兼容技术任务列表 | 1 | 已接入原分页宿主 |
| `order-time-calculator.tsx` | 时效演算导入历史选择 | 1 | 已接入原分页宿主 |
| `order-time-standard-editor.tsx` | 整体标准用时历史 | 1 | 已接入原分页宿主 |
| `sla-history-workspace.tsx` | 统一标准历史版本 | 1 | 已接入原分页宿主 |
| `sla-independent-calculator.tsx` | 独立时效演算导入历史 | 1 | 已接入原分页宿主 |
| `sla-order-application-panel.tsx` | 将标准应用到进行中订单 | 1 | 已接入原分页宿主 |
| `sla-settings-set-editor.tsx` | SLA成套设置历史 | 1 | 已接入原分页宿主 |
| `bulk-task-workbench.tsx` | 大货工序工作台操作记录 | 1 | 已接入原分页宿主 |
| `task-workbench-sample.tsx` | 开发/样品任务工作台操作记录 | 1 | 已接入原分页宿主 |

操作记录仍按 cursor 追加，关联单据目录仍按分类追加，按钮区域居中。报表预览、七栏预览及原页大小保持各自边界。
