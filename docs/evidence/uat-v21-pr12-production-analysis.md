# PR12 供应商履约与生产复盘

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 22e1cb6a465dff67607e0140e85ac29a4d455b1b
working branch: feat/uat-v21-pr12-production-analysis
task scope: 在供应商事实区与实时生产增加只读履约、在外集中和真实预警记录复盘。
allowed files: apps/api/src/sourcing/production-analysis.ts; apps/api/src/sourcing/production-dashboard-service.ts; apps/api/src/sourcing/production-dashboard-routes.ts; packages/contracts/src/production-analysis.ts; packages/contracts/src/index.ts; apps/web/src/production-analysis-panel.tsx; apps/web/src/production-analysis-model.ts; apps/web/src/production-analysis.css; apps/web/src/supplier-center-page.tsx; apps/web/src/production-dashboard-page.tsx; tests/unit/production-analysis.test.ts; tests/integration/production-analysis-postgres.cases.ts; tests/integration/production-closure-postgres.test.ts; docs/evidence/uat-v21-pr12-production-analysis.md; docs/evidence/pr12-production-analysis/*; docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md
forbidden files: 其他业务写入、状态机、旧迁移、门禁和部署策略、ERP、样衣、转厂、生产数据。

PR11 #424 首轮 Full 34139165494 / Quick 34139151053 通过；唯一 Review 请求 5572935544、结果 5573019394 未发现重大问题，无未解决线程。已按授权合并并核验 main 22e1cb6a465dff67607e0140e85ac29a4d455b1b；按相关 main 变化更新本次基线，复用已合并收货关联 SQL。

沿用实时生产角色与订单范围；返工事实额外要求既有管理报表读权限。全部筛选集汇总后分页。区分派单、首次生产记录、完工、发货、首次实收和累计实收；没有收齐确认时只报告数量达到发货值。预警 opened_at 只称首次观察，已读与投影关闭不冒充解决/恢复。不推断因果、成本、评分、供应商总产能或全局准时/返工率。

门禁 Full Gate 最多两轮，最终 Head 全绿后唯一 Codex Review，自行合并。样板实际可点击并完成五尺寸 QA 后直接接入，无 UI 确认暂停。没有 ECS 或生产数据操作。

## 实现与限制

GET /production-dashboard/analysis 通过既有 businessActor、ProductionDashboardService.read 的角色授权及 productionVisibility 全量订单筛选，包含统一 productionNotExcluded 条件。全量选定订单以同一重复读事务读取；聚合后订单与供应商分别 15 条分页。旧数据写入与生产计算不变。供应商名称快照可同名，以稳定 ID 分组；来源外发单归档不抹除有效生产历史。

未完只含生产中，剩余=订单量减有效生产上报，不累加工序。交期取派单冻结的批准值，展示决定版本；未来7天为自然日。发货业务日期和录入时间分开，首次实收及累计有效实收来自 PR11 显式 receipt_id 关联/最新逐次修订。归档批次保留明细但不计有效实收；批次级未分配调整单列，不推测对应生产订单。实收达到发货记录只称数量达到，不称质量验收/整单收齐；无明确款色行关联不分摊。

返工只在 Root 或既有 dashboard:management:read（非 Root 再调用 access_authorized_actor_roles）下查询。只把全部收货明确归属同一生产单的批次关联返工，跨单/未关联/排除关联不归属；每张返工单数量独立列示，不合计为不良件数，不输出全局率。普通生产读者质量字段为 null。

预警只读取已有 alert opened_at/closed/read 和随后首条生产记录；closed_at 文案为记录关闭，绝不冒充风险恢复时间；没有记录也不能证明历史无风险。无新增预警投影写入、日志采集或因果推断。

## 验证

- 定向 ESLint：全部新服务/契约/组件/测试和两处入口通过。
- 严格 TypeScript：实际新分析服务、PR11 关联服务、契约、UI、分页通过；本地外围 Auth/TrustedActor 类型为夹具，完整工作区以当前 Head Full Gate 为准。
- 11 项单元测试通过：交期边界、关闭状态、非法筛选、稳定 ID、前端角色与 capability、质量权限裁剪、实际 Fastify 路由无业务角色拒绝/授权路由与 no-store。生产对象范围继续由原 service.read/productionVisibility 决定，不因路由通过而放宽。
- 7 项 PGlite SQL 测试通过：20 单 15+5 分页、18 单未完剩余1080、同名供应商分开、归档来源保留、明确收货修订95件与发货90件分项、批次调整未分配、共享批次返工不归属、已读预警未关闭、普通填报人员质量遮蔽及范围之外记录不返回。测试会话显式 UTC，业务分组用上海日期。
- 新 cases 由既有 production-closure-postgres.test.ts 导入进入原业务链 Full Gate；本地 PGlite 不替代真实 PostgreSQL。
- 实际 React 组件 Vite 构建 124 模块通过；样板源 6bd71778940bc9ac9be24a6dda5313d4cdd62cd5。只有外围 Auth/API 是合成夹具。
- 五尺寸实时生产分析及 1440/360 供应商事实区真实浏览器截图见 pr12-production-analysis/；按 iframe 视口捕获，不冒充整页长截图。主题切换、明细展开、503 保留10个原单入口、空结果、403 清空为0的交互核验通过。原生产单/返工链接使用原权限页面，未在样板内伪造业务提交。

## 回滚

回滚本 PR 移除两处分析入口和新只读接口；无迁移/生产状态/数据回滚。缺少明确历史关联的部分保留核查提示，不补造事实。没有 ECS 或生产环境 UAT。
