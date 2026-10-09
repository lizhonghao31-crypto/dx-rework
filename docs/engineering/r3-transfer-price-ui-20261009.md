# R3 转厂四位价格 UI 小修

## 一次施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1
- base SHA: 130a58e7a1910e445d2de1e6510e911329f5add8
- working branch: fix/r3-transfer-price-input
- task scope: 首次聚焦转厂单价保留既有四位原串，转厂总额预览使用既有逐行精确计价。
- allowed files: sourcing-workspace-page.tsx、sourcing-price-presentation.ts、相关测试/合成 fixture、本证据。
- forbidden files: API、金额契约/计算引擎、审批规则、冻结/PDF、迁移、依赖/部署工具、其它模块输入。
- gate class: FULL（金钱输入与预览）。

## 根因与最小修改

父执行者在 a8e605ad 真正 Acceptance TEST 单验证：20件、4.1234 元，服务正确计价 82.47、PDF冻结4.1234；未手改再次提交仍为4.1234。卡片两位金额展示是既有规范，不是财务错账。

原输入 value 在首次聚焦仍要求 edited=true，DOM显示4.12，因此用户从末尾局部退格实际写回4.1。移除该条件与仅用于条件的状态，首次聚焦直接显示 draft原串4.1234，失焦仍按既有金额展示4.12；默认、加载、重置与提交仍保留原值。

转厂余量预览复用普通报价两位校验而显示“—”。现只为转厂调用既有 calculateSourcingLinesTotalExact，逐行按实际余量取分再汇总；普通 IE/管理报价两位校验不变，API 四位 BigInt 审批比较、冻结及 PDF 未修改。

## 独立复现与回归

tests/fixtures/r3-transfer-price-preview.tsx 挂载实际 SourcingWorkspacePage；所有 GET 为合成数据，所有 POST 被截取并返回403，未调用任何真实 API/业务数据库。tests/acceptance/r3-transfer-price-offline.mjs 使用独立本地 Chromium，未接触父的 cloudbrowser session。

| 检查 | 130a58e 原版 | 候选 |
| --- | --- | --- |
| 未手改单价提交 | 4.1234，正确 | 4.1234，保持 |
| 首次聚焦原4.1234 | DOM 4.12 | DOM 4.1234 |
| 首次聚焦末尾退格并提交 | 4.1 | 4.123 |
| 20件四位预览 | — | 82.47 |
| 失焦金额展示 | 4.12 | 4.12 |
| 五位非法价预览 | — | —，既有契约拒绝 |
| 两行各1件、单价4.1234 | — | 4.12+4.12=8.24，禁止先合数量取分成8.25 |

价格函数回归同时覆盖4.125两行得8.26、空价/零/负数/科学记数/混入逗号/未完小数/超四位/空余量拒绝；普通报价4.1234仍拒绝。原生 sourcing 工厂转移、角色、原价格阈值与余量分配回归另在本轮拥有的非超级用户隔离 PG16/schema 运行。

本地定向价格函数/输入/cascade18项及更新的转厂页面契约通过；原生工厂转移角色/阈值与两组余量分配3/3；实际页面离线 Chromium 五组通过（无pageerror），保留原四位涨跌方向。lint/typecheck/build（含postbuild静态链77项）、migration lint、secret scan和diff check通过。整库旧契约已更新为首次聚焦保留原串，最终422文件2117项通过（60文件506项环境相关跳过，原生3项另行实跑）；当前Head的远端FULL及一次Codex Review以PR记录为准。

本地浏览器只是合成 UI 回归，不能替代用户部署后的实际 Acceptance 验收。无部署、真实业务数据、权限或首页修改。
