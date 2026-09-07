# UAT/UI/数据升级 V2.1 执行台账

## 当前接手事实（2026-09-07）

- repository: lizhonghao31-crypto/dx-rework
- route: PR01 规则收口与导航图标
- base branch: main
- base SHA: e0f1681dfa8d6007b3a682bc4b80b660e5914ebf（本次远端实际读取，与附件历史快照恰好相同）
- working branch: feat/uat-v21-pr01-rules-icons
- task scope: 版本化已批准变化，提供复用现有Shell及图标组件/CSS的可点击样板，确认后才接壳。
- UI sample status: 2026-09-07 业务负责人回复“确认 开始”，已批准图标样板；在原 PR01 接入。
- required gate: 共享壳已接入，创建普通 PR 后立即加 full-gate；最终 Head 全绿后进行必要 Review，最多一次。
- review/merge authorization: 本轮Work自行判断并触发必要Review（所需Gate全绿后、每PR最多一次），修复、合并和继续；覆盖手动Review/合并和PR创建后结束的流程默认。样板确认、部署与生产数据边界不变。

### 远端进度

本次开放PR查询为空；按创建时间检查最近已合并PR为#413（样衣金额输入与独立验收顺序）、#412（切换详情隔离）、#411（迁移对账）。本轮计划目标路径尚不存在；当前代码仍以圆点/文字作为导航图标，没有本轮图标映射，PR01未实施。规则索引“样衣尚未开工”“SSP-08待建设”已过期，本次按远端代码和规则修正；不重做已完成代码。

GitHub读文件、读取提交、PR和CI元数据以及Git对象写入通道已暴露；本次工作分支已成功创建，不以账号admin标志代替实际写入证据。直接HTTPS git读取缺少终端凭证，采用已连接的GitHub API，不寻找旧工作树、不切换Codex Cloud。浏览器已连接，样板使用独立合成数据。完整仓库Node22/npm10门禁与ECS部署不由当前Node24临时编译结果替代。

部署SHA、登录状态、当前生产开关及本轮业务验收尚未核验，不能因PR合并或历史UAT报告而标记本轮通过。样衣生产切换仍遵守独立验收、最终证据、对账与备份保护；不通过开关模拟Root测试模式。

### PR01精确文件边界

本次 PR01 允许修改：

- AGENTS.md
- docs/requirements/startup-requirements-v1.2.md
- docs/requirements/rework-ui-golden-source-v1.0.md
- docs/requirements/sample-system-migration-v1.0.md
- docs/requirements/sourcing-supplier-production-v1.0.md
- docs/roadmap/platform-2.0-rules-index-v1.0.md
- docs/roadmap/uat-ui-data-upgrade-v2.0.md
- docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md
- apps/web/src/navigation-icon-data.ts
- apps/web/src/navigation-icons.tsx
- apps/web/src/navigation-icons.css
- apps/web/src/navigation-icons.LICENSE
- scripts/navigation-icon-preview.mjs
- scripts/navigation-icon-preview-transform.mjs
- tests/fixtures/navigation-icon-preview.tsx
- tests/fixtures/navigation-icon-preview.css
- docs/evidence/uat-v21-pr01-icons.md

2026-09-07 样板确认后追加冻结：apps/web/src/components.tsx、packages/ui/src/index.tsx、apps/web/src/sourcing-workspace-page.tsx、apps/web/src/supplier-center-page.tsx、tests/unit/navigation-icons.test.ts。补充实际自有标题路径：apps/web/src/admin-console-page.tsx、apps/web/src/my-todos-page.tsx、apps/web/src/order-board-page.tsx、apps/web/src/employee-access-page.tsx。补充二级入口与工资标题：apps/web/src/wages/wage-period-list.tsx、apps/web/src/system-management-navigation.tsx、apps/web/src/production-dashboard-page.tsx、apps/web/src/production-reporting-page.tsx、apps/web/src/master-data-page.tsx、apps/web/src/workforce-master-data-page.tsx。接入证据路径：docs/evidence/pr01-icons/integrated-mobile.jpg、docs/evidence/pr01-icons/integrated-desktop.jpg、docs/evidence/pr01-icons/integrated-geometry.json。仅接入图标与兼容 ReactNode 的类型，路由、导航顺序和权限不变。样板构建改为直接使用真实 Shell；原样对照以显式逆转换保留。样板选择器与示例详情不会进入生产。

禁止修改：apps/api/**、任何数据库迁移/生产数据、既有返工业务页面及状态/数量/金额逻辑、钉钉及Root权限、.github/workflows/**与CI治理脚本、部署配置、依赖及锁文件、PR02—13业务实现。许可文本仅随SVG图标保存，不引入运行时图标库。

## 固定路线台账

### PR01样板交付

- 可点击样板：https://dx-pr01-icons-20260907.lizhonghao31.chatgpt.site
- 样板实现提交：51305d36fd8effb1c1c63ef660a295105f8d87f3；本次后续证据提交只登记链接，不改变组件。
- 图标初稿及原样入口已构建；五尺寸初稿截图、页面宽度检查及定向lint/typecheck通过，限制见docs/evidence/uat-v21-pr01-icons.md。
- 图标样板已由业务负责人确认。共享 Shell、实际自有标题和二级入口已接入；提交后创建普通 PR 并立即添加 full-gate。
- 样板为独立私有演示；ECS未部署、生产业务未操作。下一步为当前 Head Full Gate、必要 Review 与授权合并。

| 路线 | 状态 | 下一步 |
|---|---|---|
| PR01 规则收口与导航图标 | 施工中；样板已确认、接壳完成 | 当前 Head Full Gate 与必要 Review 后合并 |
| PR02 样衣上传阻断 | 未开始 | 按计划核验申请/上传/finalize |
| PR03 供应商操作安全 | 未开始 | 按原范围施工 |
| PR04 数字规范与非转厂外发收口 | 未开始 | 按原范围施工 |
| PR05 测试生产记录隔离 | 未开始 | 按原范围施工 |
| PR06 供应商UI | 未开始 | 中文可点击样板先确认 |
| PR07 样衣操作UI | 未开始 | 中文可点击样板先确认 |
| PR08 实时生产UI与动效 | 未开始 | 动态样板及录屏先确认 |
| PR09 样衣分析数据层 | 未开始 | 按原范围施工 |
| PR10 样衣经营分析UI | 未开始 | 中文可点击样板先确认 |
| PR11 回货装箱分析 | 未开始 | 按原范围施工 |
| PR12 供应商履约与生产复盘 | 未开始 | 按原范围施工 |
| PR13 流程与操作分析 | 未开始 | 按原范围施工 |

## 风险与数据台账

UAT-03多款价转厂P1延期，未修复、不关闭入口。本轮不能声称四模块零P1。

本阶段没有生产写入，没有创建测试订单或样衣。遗留生产单954fa950-b31f-4138-9838-4d3fb06ad8df留给PR05；执行前核对精确对象与关联影响。不得按TEST名称扫库或操作迁移样衣。

### PR01 门禁修复（#414）

- 当前第一次 Head：344e3c7ccd846a1f2066cf3d5c6a8a8045a8e240；Quick Gate 通过。Full Gate 34102797390 的 lint/typecheck/build 通过，测试仅两项旧纯文本标题断言失败，其余1161项通过；未将条件跳过的数据库测试计为通过。
- 追加精确允许路径 tests/unit/business-facing-workflow-ui.test.ts、tests/unit/platform-permission-navigation-hub.test.ts，仅使标题断言包含已批准图标，所有业务只读、菜单顺序、Root和权限断言保留。将集中提交后运行第二次 Full Gate，不 rerun 旧失败 Head。

### PR01 独立 Review 与待授权门禁

- 最终已验证 Head 0fb847cb2257f023689df95c6cd18e6c018b545e，第二次 Full Gate 34103213343 通过。ci.yml 在 full-gate 标签存在时主动跳过重复 Quick Gate；未将 skipped 计为成功。
- 已触发唯一一次 Codex Review，review 5130083650、comment 3948177416 指出 P2：外发别名与详情未使用规范标题图标。
- 本地修复：外发创建、列表（含 /ui/sourcing 别名）、详情明确传入 iconRoute；不放宽未知路由匹配，不改路由或状态。增加定向回归。
- 第三次 Full Gate 需按 AGENTS.md 第11节单独授权。修复先保存为可审阅 Git 提交对象，未移动 PR Head、未自动启动第三次 Gate；不再次触发 Review。
