# PR11 回货装箱分析

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 6bb8d9b9bd42eb737d6ed983ebc201a86a834268
working branch: feat/uat-v21-pr11-receiving-analysis
task scope: 在订单回货增加只读差异汇总、版本历史及原单据入口，复用明确收货生产关联。
allowed files: apps/api/src/receiving/receiving-service.ts; apps/api/src/receiving/receiving-analysis.ts; apps/api/src/receiving/receiving-routes.ts; packages/contracts/src/receiving-analysis.ts; packages/contracts/src/index.ts; apps/web/src/receiving-analysis-panel.tsx; apps/web/src/receiving-analysis.css; apps/web/src/order-board-page.tsx; tests/unit/receiving-analysis.test.ts; tests/integration/receiving-analysis-postgres.cases.ts; tests/integration/receiving-postgres.test.ts; docs/evidence/uat-v21-pr11-receiving-analysis.md; docs/evidence/pr11-receiving-analysis/*; docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md
forbidden files: 其他业务代码、旧迁移、工作流/门禁策略、部署配置、生产数据、ERP、样衣与转厂。

门禁：Full Gate 最多两轮；最终 Head 全绿后独立 Codex Review 一次；按本轮授权自行合并。可点击样板及五尺寸 QA 后直接接入，不再请求 UI 确认。没有 ECS 或生产数据操作。

沿用现有订单回货的标准化款号汇总口径；跨生产订单只通过 receipt_id → production_order_id 的既有显式关联，不能把款号汇总当作供应商订单。当前装箱取操作批次最新不可变版本；回货差异为实收减送货单、装箱差异为装箱减实收；历史处理快照原样返回。没有“最终损耗”推断。详细验证随实现补齐。

## 实现与口径

原订单回货只增加折叠分析入口，不改变录入、差异处理、装箱、导出或权限。GET /receiving/analysis 先复用原读权限，服务层再次拒绝无业务角色；未知/非法筛选返回 400；响应 no-store。统一只读重复读事务，全部符合筛选款号先聚合，明细分页 15 条。数量以整数字符串传输，展示边界格式化。

复用现有 RECEIVING_BOARD_BASE_SQL：有款号搜索沿用全历史模式，无搜索取期间出现的款号并累计至期末；装箱为当前最新版本，页面明确两种时间范围。标准化款号是既有仓库汇总口径，不作为跨生产单归因键。送货单不会随分批重复相加。当前处理匹配有效数量/装箱版本；历史处理保留原始差额，包含 0140 之前方向。

PR12 可复用 RECEIVING_ANALYSIS_LINKS_SQL，逐次修订取明确 correction_id。批次级调整不分摊给某生产订单；明细颜色无明确行关联时不猜测。历史收货无生产链接单列；生产已排除的关联保留覆盖数但不回传生产/供应商上下文。未创建新数据库对象、未回填或操作生产数据。

## 验证

- 定向 ESLint：API 3 文件、新契约、分析组件、原页面及新测试通过。
- 严格 TypeScript：实际新分析服务/契约/UI/原分页组件通过；本地仅外围身份类型与 Auth 为夹具，完整工作区以远端 Full Gate 为准。
- 6 项单元测试通过：日期/分页/未知筛选拒绝、无角色 403 优先于查询和数据库连接、授权用户非法筛选 400。
- 6 项 PGlite SQL 测试通过：17 款 18 批、15+2 分页/全量 360 对 260、分批送货单不重复、最新装箱与已处理非零差额、旧方向快照保留、缺装箱空值、明确修订关联、排除遮蔽、空结果与 asOf。真实 PostgreSQL 用例由既有 receiving-postgres.test.ts 导入，在固定业务链 Gate 执行；PGlite 不冒充远端 PostgreSQL。
- 实际 React 分析组件 Vite 静态构建通过（122 模块），样板源 01795b5ae02a5a9e8c7f06e9f6374d0e04611b2d。Auth 与接口使用隔离合成夹具，无生产读写。
- 五尺寸 1440×1024、1280×800、768×1024、390×844、360×800 的真实浏览器截图位于本目录 pr11-receiving-analysis/；截图显示对应 iframe 视口，不宣称整张子页面长截图。已有处理筛选、展开原单与版本、空结果、503 保留和 403 清空运行核验通过。送货单链接复用现有受控下载路径，未在合成样板中冒充实际 OSS 下载验收。

## 风险与回滚

只读汇总仍继承旧仓库标准化款号口径；不能将该层差额归责某供应商。期间实收与当前装箱有明确时间提示，不能解释为历史某日最终损耗。原操作仍可独立使用。回滚本 PR 即移除新入口与只读接口，无数据库迁移或数据回滚。生产环境尚未部署/验收。
