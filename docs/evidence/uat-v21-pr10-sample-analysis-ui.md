# PR10 样衣经营分析UI

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 84faa25112d2bf69668edf88fa070f341157f1c2
working branch: feat/uat-v21-pr10-sample-analysis-ui
task scope: 固定PR10，原库存金额入口升级为采购/当前持有/处置分析，复用PR09接口与旧金额对账。

允许：apps/web/src/sample-analysis-page.tsx、sample-analysis-view.tsx、sample-analysis-model.ts、sample-analysis.css、sample-workspace-page.tsx；tests/unit/sample-analysis-ui.test.ts；本证据及docs/evidence/pr10-sample-analysis-ui/*.jpg；docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md。

禁止：后端/契约/数据库、金额计算口径、身份授权、借还处置状态机、其他模块、共享Shell/token、CI/部署、生产记录。样板与实际组件复用，后续UI按用户最新授权无需逐次确认。Full Gate最多2轮；Review按风险判断最多一次。

## 本地交付证据

样板源版本 d5723b2bd650468e7822a6eff9779aacb6893380，页面/视图/模型与业务源码一致，Shell和身份为隔离替身、接口为合成响应。固定五尺寸、手机展开筛选、同名稳定ID选择18→9条、持有指标联查18→16条、主题、排行、分页、空结果、503保留原范围、403清空金额/旧对账/明细均核验。样板详情为合成弹窗；业务使用既有样衣详情链接。

10项UI权限和查询映射测试、定向ESLint、隔离严格TypeScript与126模块实际页面构建通过。未改变API、业务权限或金额口径；图表数值转换只用于条形长度，显示仍用精确十进制格式化。

旧amounts模式由单独分析页面承接，其余在管/待确认/处置/详情组件维持原入口；不触发旧金额与新分析的双重组件加载。未分类归档和旧全量对账明确标识，申请中的筛选不会冒充上次成功结果口径。

Review判断：后端在PR09独立审查；本PR只读UI及前端权限可见性，采用模型允许/拒绝测试、真实组件交互和Full Gate，不追加Codex Review（0/1）。回滚revert本PR。无ECS部署或生产操作。

样板：https://dx-pr10-sample-analysis-20260907.lizhonghao31.chatgpt.site ，已私有发布成功。PR09 #422最终Head ef9c4469de4de211be5551e6932539341e9b4496 的Full34135432268通过，真实PostgreSQL的sample-read19项（含分析6项）通过；Review评论5572553777未发现重大问题。Work已合并，业务接入基于84faa25112d2bf69668edf88fa070f341157f1c2。
