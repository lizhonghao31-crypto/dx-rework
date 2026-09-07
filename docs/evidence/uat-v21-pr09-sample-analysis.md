# PR09 样衣分析数据层

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 025ee8f9bb9d8f9f0581b1a1559df1e9ffc3eeae
working branch: feat/uat-v21-pr09-sample-analysis
task scope: 固定PR09，只读全量采购/持有/处置分析、精确金额、别名及归档分类查询基础。

允许：apps/api/src/samples/sample-analysis-service.ts、sample-read-service.ts、sample-read-routes.ts；packages/contracts/src/sample-analysis.ts、index.ts；apps/api/migrations/0160_sample_analysis.sql；apps/api/src/platform/migration-manifest.json；tests/unit/sample-analysis.test.ts；tests/integration/sample-analysis-postgres.test.ts；本证据、docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md。

禁止：旧金额接口口径、样衣状态机/人员角色、原采购价、旧迁移、前端、外发/返工、共享壳、CI/部署配置、生产数据、540件迁移样衣。

Full Gate最多2轮，当前最终Head绿后请求一次Codex Review。本阶段无生产写入或部署。数据截至时间来自只读REPEATABLE READ事务；采购日期筛选后的当前状态并非历史库存。处置批准和确认赔付使用各自事实日期。

旧归档未区分历史与作废：新增可审计分类事实基础，未分类数明确提示，不从名称/原因推断。旧金额接口保持；分析分别说明有效采购历史、旧对账范围、归档待核查和明确测试作废。别名只读取明确的稳定ID映射，保留原文与版本；迁移不填充任何生产映射。配置事实需后续获授权的精确操作，当前不提供泛化写接口。

PR08合并形成相关新main，已按025ee8f9重新定位基线；PR09已读取的样衣服务/契约/迁移在该合并中未变化。

## 验证与限制

- 20项查询/金额权限单测通过；允许finance/approver/owner/root，拒绝designer/administrative/system_admin/worker，含HTTP恶意金额查询。
- PGlite隔离PostgreSQL引擎执行真实迁移SQL和5项数据库回归通过：全量21条/分页15+6、精确金额501.70/旧范围301.70、未知归档300.00单列、测试排除、明确历史保留、同名不同ID、显式别名原文/版本、采购日期与审批/赔付日期分离、未付款不计回款、不可变记录、索引EXPLAIN。PGlite为本地SQL兼容核验；GitHub Full Gate的真实PostgreSQL为最终证据。
- 定向ESLint与隔离严格TypeScript通过；类型隔离只替代AuthUser/RootAuthority/TrustedActorContext三类外围类型，业务服务/契约使用实际代码。完整workspace build以当前Head Full Gate为准。
- 本PR没有UI和导出接口；PR10复用此API，不增加金额权限。未分类归档不静默并入旧总账或认定作废，明确显示数量/金额待核查；显式历史分类才纳入分析采购历史。归档原详情仍按既有Root限制，响应canOpenDetail明确标识。
- 映射与分类表只提供读取基础，不提供普通用户写入口，不写默认生产映射；后续精确配置必须遵循当时的生产授权。所有名称分组使用稳定ID或明确原文本键，人员名称只作展示。
- 回滚：revert代码，保留新增映射/分类事实表，不回写或删除原业务数据。
