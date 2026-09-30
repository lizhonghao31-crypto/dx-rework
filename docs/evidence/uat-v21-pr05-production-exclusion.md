# PR05 测试生产记录隔离

## 施工前预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: c5154a86fdd3bf71babe4ec5f11e5c261bb4f71f（PR03合并后实际读取）
working branch: feat/uat-v21-pr05-production-exclusion
task scope: Root精确对象预览/排除，原因审计、幂等与版本保护，并统一生产列表、动态、预警、预期回货的排除口径。

允许文件：
- apps/api/migrations/0159_sourcing_production_exclusions.sql（新增）；apps/api/src/platform/migration-manifest.json（仅追加校验项）。
- packages/contracts/src/sourcing-production.ts。
- apps/api/src/sourcing/production-exclusion-service.ts（新增）、production-visibility.ts（新增）、sourcing-production-service.ts、production-reporting-service.ts、production-reporting-routes.ts、production-dashboard-service.ts、production-closure-service.ts。
- apps/web/src/production-exclusion-controls.tsx（新增）、production-dashboard-page.tsx。
- tests/unit/production-exclusion.test.ts（新增）、tests/integration/production-closure-postgres.test.ts（加入真实PG回归，沿用既有业务门禁执行入口）。
- scripts/production-exclusion-preview.mjs、tests/fixtures/production-exclusion-preview.tsx（新增离线实际控件验证）。
- 本证据、pr05-exclusion/desktop.jpg、mobile.jpg、docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md。

禁止修改：旧迁移、历史生产/外发/收货事实、Root生产权限和开关、ERP、样衣、返工、生产状态机、计价、CI/部署配置、依赖与锁文件。

查询中新增独立排除条件是本路线明确授权的原逻辑增量；未标记记录（包括正常历史归档）行为保留。标记不更改原状态，不按名称推断、不硬删历史。精确排除记录保留独立审计，Root通过同一入口可回看。

生产执行白名单仅报告明确遗留ID954fa950-b31f-4138-9838-4d3fb06ad8df，实际执行前仍需核对对象和关联影响；当前阶段仅实现能力与合成测试，没有操作该生产对象或其他真实数据。

## 已实施与测试边界

- 0159新增独立不可变排除表，主键精确productionOrderId；必须匹配Root角色、对象、预览版本及原因的审计事件。UPDATE/DELETE/TRUNCATE拒绝，旧158项manifest内容保持原样。没有给生产权限加角色或改Root身份。
- Root只读预览在一致性事务内读取原生产白名单字段、上报/修正数量、实际收货ID和排除原因；不输出单价、大兴价或银行资料。版本指纹覆盖对象及上报/状态/收货稳定ID，新增事实使旧预览失效。
- 排除操作锁定同一生产行，执行既有幂等存储，并在生产风险投影锁内追加审计/标记和解除未决预警。同key重放返回原回执，不改原因；不同对象确认或过期预览拒绝。
- 三类执行事实（上报、状态转换、收货关联）的新写入由数据库触发器同一行锁保护，已排除对象不能再接收新业务事实。旧事实不改、不删。
- 正常派单生产列表/详情、填报列表/详情、看板计数/筛选/动态、预警、预期回货采用同一NOT EXISTS条件；外发单原派单回执仍保留，防止排除后误建第二份生产单。正常外发归档不等于排除。
- Root入口复用既有Surface/Button、sourcing-form-grid与system-dialog；输入ID更改立即清掉旧预览，确认等待中同步锁定字段及按钮，网络不明可按原幂等key恢复。
- 本地3项安全测试通过，覆盖非Root在数据库连接前拒绝、完整确认/原因/ID/版本/已排除保护、事实变动版本变化。变更文件定向ESLint和实际控件Vite构建通过。
- PostgreSQL回归补入既有production-closure-postgres.test.ts（已在现行business-chain门禁清单中），覆盖Root/非Root、对象不匹配、过期预览、并发同key、审计唯一、列表/看板动态/待办统一排除、原生产上报保留及原外发归档仍可查询。当前本地无PostgreSQL，执行结果以最终Head Full Gate为准，不宣称已经执行PG回归。
- 浏览器合成测试：空原因按钮禁用；预览后模拟新增上报，实际POST返回409，原因和精确对象保留且中文提示重新预览；确认期间ID/原因/预览/排除均禁用。重新预览后完成合成排除，原对象仍显示且附带排除原因。桌面1280×800与手机390×844截图仅证明可见区域，不代表线上UAT。

## 回滚与生产执行

可回滚本PR应用提交；0159是加法结构，已记录的审计标记不能通过删表方式“清理”。若在实际排除后回滚应用代码，旧版本不识别标记会重新显示对象，需先评估可见性再回滚；当前尚无生产部署或生产标记。

真实对象954fa950-b31f-4138-9838-4d3fb06ad8df仍未处理。不得将本地合成成功、门禁通过或PR合并写成UAT-04生产清理完成。
