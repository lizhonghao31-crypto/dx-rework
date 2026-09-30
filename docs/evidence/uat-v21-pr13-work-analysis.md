# PR13 流程与操作分析

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 53682a0c9b8486f707a248b66f2432a3ec3de1e6
working branch: feat/uat-v21-pr13-work-analysis
task scope: 固定 PR13，普通报价事实对照、管理工作台流程等待与往返、原审计入口聚合操作诊断。
allowed files: packages/contracts/src/work-analysis.ts; packages/contracts/src/index.ts; apps/api/src/sourcing/sourcing-analysis.ts; apps/api/src/sourcing/sourcing-service.ts; apps/api/src/sourcing/sourcing-routes.ts; apps/api/src/reporting/workflow-analysis.ts; apps/api/src/reporting/management-reporting-service.ts; apps/api/src/reporting/management-reporting-routes.ts; apps/api/src/platform/operation-diagnostics.ts; apps/api/src/admin-audit-service.ts; apps/api/src/admin-audit-routes.ts; apps/api/src/app.ts; apps/api/src/server.ts; apps/api/migrations/0161_work_operation_diagnostics.sql; apps/api/src/platform/migration-manifest.json; apps/web/src/work-analysis-panel.tsx; apps/web/src/work-analysis-model.ts; apps/web/src/work-analysis.css; apps/web/src/sourcing-workspace-page.tsx; apps/web/src/reporting/management-dashboard-page.tsx; apps/web/src/admin-console-page.tsx; tests/unit/work-analysis.test.ts; tests/integration/work-analysis-postgres.cases.ts; tests/integration/sourcing-pr03-postgres.test.ts; docs/evidence/uat-v21-pr13-work-analysis.md; docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md; docs/evidence/pr13-work-analysis/*; apps/web/src/reporting/rework-query-page.tsx
forbidden files: 其他业务写入、状态机、历史迁移、CI/门禁策略、部署策略、ERP、转厂、生产数据。

开工已核验远端 main。PR12 #425 最终 Head 0610e1d93edd3c7f428428251c6d0de629272132 首轮 Full 34141420827、Quick 34141419857 成功，唯一 Review 5573229094 待回；合并后只按相关变化更新 PR13 基线。以上允许文件在实现前冻结。

沿用各入口原权限，不通过流程汇总释放报价、返工金额或审计输入。实际可点击样板 QA 后直接接入业务，不再等待 UI 确认。Full Gate 最多两轮，必要 Review 最多一次，按现有授权自行合并。没有 ECS 部署或生产数据操作。

操作诊断优先使用既有事件；只对缺失的写入失败/成功追加必要记录。不采集原始 URL、对象/人员/请求 ID、请求头、表单、完整错误或业务载荷。重试仅展示服务端已确认幂等重放，不臆测失败后的因果结果。历史缺失明确呈现。

PR12 已合并，最终 Head 5e144f43851e27d5b67d266151a5c3d67a1faa08，第2轮 Full 34143120211 成功、Quick 按 Full 策略跳过；唯一 Review P2 主题/旧响应错配已修复、浏览器双向503验证，线程已解决。main 53682a0c9b8486f707a248b66f2432a3ec3de1e6 已核验，PR13 契约索引按相关合并更新。

## 实现与口径

普通报价 GET /sourcing/analysis 使用原 readActor / assertReader。只从不可变款色、全部 IE 版本、普通决定对应批准快照读白名单字段，不读银行、内部达兴价或合同私密字段；历史单价十进制字符串最多4位，批准数量/款色单列，不把兼容首行价乘全单。转厂批准快照被过滤；归档真实原单保留并标识，无旧详情链接冒充可打开。

流程 GET /management/workflow-analysis 使用原管理报表 require；外发部分额外需 sourcing:view（非 Root 再验证 DB 能力）。返工当前进入取最后一次真实状态变化，不以 updated_at 推算；普通外发从 transition.sequence 取进入/离开，同状态财务核对和补充不重置等待时钟。往返与图片补充按真实记录时间展示，未记录节点不臆造。财务独立筛选，不计入当前等待阻断组。流程 DTO 不含人员排行或金额。

诊断 GET /admin/audit/diagnostics 复用原 owner_group 或 system_admin + audit:read。0161 仅增加最小诊断表及索引，append-only 触发器；应用 onResponse 白名单阶段，onError 仅存受限码，写诊断失败不改变业务成功响应。只展示已保存请求，不声称覆盖全部请求。服务端真实 reused 回包头才计幂等重放成功；未关联到先前失败，不做因果归因。阶段归类不读取原始 URL、用户/对象/请求 ID、body、cookie、token 或完整错误。共享附件核验仅为通用阶段，不推断其业务内容。已有字段修订只返回白名单字段名及计数、无值，缺失前后快照不冒充0次修改；与请求分类分开标明日期范围。没有后台屏幕回放或人员监控。

三处都是原页面的折叠只读入口；全部聚合再15条分页、统一重复读 asOf、成功响应筛选标签，503 保留原成功范围，401/403 清空。未触动原提交/生产状态机、菜单、返工布局或审核流程。

## 验证

- 8项单元测试：非法筛选在连接前拒绝、历史精度、权限隔离、固定安全码、真实 Fastify 写入钩子不采集敏感输入/不信客户端重放头/不记录读取和转厂、诊断失败不改变成功业务响应、原审计权限在查询前阻断。
- 8项 PGlite SQL 测试：17原单15+2全量汇总、归档缺失初价、IE各版本/批准数量/四位价、转厂批准排除、财务独立与老板驳回、同状态核对不重置进入、补充不造节点、无外发权限不返回外发、缺失进入不补造、安全诊断分类、字段白名单、append-only/约束、索引存在及可执行 EXPLAIN ANALYZE。由原 sourcing-pr03-postgres.test.ts 导入纳入业务链真实 PostgreSQL Gate；本地 PGlite 不替代它。
- 全部更改 TypeScript/TSX 定向 ESLint 通过；新契约/SQL服务/钩子/真实 UI 严格类型通过，本地外围 Auth 为类型夹具，完整工作区由最终 Head Full Gate 验证。
- 实际 React 样板 Vite125模块通过。三个主题各五尺寸截图与360报价明细，见 pr13-work-analysis/；截图按 iframe 视口，不冒充子页面完整长图。报价分页、四位价、财务独立与往返展开、503保留已应用财务筛选、技术故障分类、空结果、403清空已实际核验。
- 样板源 a2d398415edee26925b198d51b7ab3b52dd83421；只有外围 Auth/API 为合成夹具，未声称真实业务详情点击或生产 UAT。

## 回滚与未覆盖

回滚代码可移除三处读取入口与诊断钩子；0161 表保留历史记录，不能倒改旧迁移或清空审计，后续变更用新迁移。历史缺失失败/重试、没有前后字段快照以及缺少节点事件均明确保留缺失。没有 ECS 部署、线上日志采集验证或生产数据操作。

## 唯一 Review 修复开工边界补充

Review PRR_kwDOTpHFhc8AAAABMgWs7Q 的线程 PRRT_kwDOTpHFhc6f_LY0/LY1/LY2 分别指出入口不可达、转厂混入计时、分页前构建全部报价明细。核验现行 App：/ui/tasks 实际路由至 reporting/rework-query-page.tsx，原 AuthGate 明确允许 dashboard:management:read；/ui/supervisor 为 site 模式，原新增 management-only 入口不可达。为在原可达管理查询入口闭环，本次在修改前追加允许文件 apps/web/src/reporting/rework-query-page.tsx，撤回 management-dashboard-page.tsx 的新增入口。App、路由、菜单和权限不改，新增面板仍单独验证管理读权限，不重排返工业务流程。其余修复限原允许的两个SQL服务、既有测试、Root前端判定与证据。全部集中使用第2轮Full，不重复Review。

修复验证：实际 /ui/tasks 所用 ReworkQueryPage 已在样板直接挂载（外围 Auth/报表读取为空夹具），展开流程、财务独立、原有筛选保留，五尺寸截图已更新；静态核对原 App 的真实路由及 dashboard:management:read 父级允许，未声称整份 App/真实登录联调。报价同一重复读事务分别计全量总数/缺初价数，MATERIALIZED selected CTE 在构建任意款色/IE/批准 JSON 之前 LIMIT/OFFSET；页99仍正确返回全量17及缺失1而明细空，EXPLAIN ANALYZE 验证 selected CTE仅15行。新增转厂进入/驳回回到财务的真实SQL夹具，普通finance enteredAt与先前普通节点leftAt不被转厂改变，历史不返回转厂。

另自行补齐 Root 无业务角色时原普通报价/管理分析可见规则；审计仍严格沿用原角色规则。现为9项单元和9项PGlite通过，修复服务/真实组件严格类型、变更文件ESLint通过；修复后样板构建134模块。集中推送第2轮Full，不再次请求Review。前述首轮125模块与8+8项为历史证据。

修复后同一私有样板第2版源 d2ab8b1ba6b32994d69d06df066e4d516e23c14c；actual query page入口额外截图1440-workflow-entry.jpg。未新增一级页面或修改路由。
