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
| PR01 规则收口与导航图标 | 已合并 #414；未部署 | 合并 SHA cc6d43ac3601，业务验收待部署 |
| PR02 样衣上传阻断 | 已合并 #415；未部署 | 合并 SHA 587db6a5e440，UAT-01待线上验收 |
| PR03 供应商操作安全 | 已合并 #416；未部署 | 合并 SHA c5154a86fdd3，线上 UAT 待部署 |
| PR04 数字规范与非转厂外发收口 | 用户已合并 #417；历史单价P2待闭环 | 修复对象10ec2dcf未纳入main |
| PR05 测试生产记录隔离 | 用户已合并 #418；未部署/执行 | 合并ee1643b5，Full34121883047通过 |
| PR06 供应商UI | 已合并 #419；未部署 | 合并49e535e5，Full34123878178通过 |
| PR07 样衣操作UI | 用户已合并 #420；未部署 | 合并1e797116，Full34129323500通过；唯一Review未返回 |
| PR08 实时生产UI与动效 | 样板与录屏已完成，按新授权直接接入 | 仍做五尺寸/动效核验及当前Head门禁 |
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


## 最新进度：PR01 已合并，PR02 施工

- PR01：用户明确授权第三次 Full Gate；de31ce6cf4b7e5b35e6bce2f5b453a36fec82d29 的运行34104546306通过。唯一一次Review指出的外发别名/详情图标P2已修复，未二次触发Review。#414已squash合并，main实际读取cc6d43ac3601765fdf58e4dc5cd5dc9047855c5a。以上事实取代前述“待授权/待合并”历史 checkpoint；ECS未部署。
- PR02：基于上述main，分支feat/uat-v21-pr02-sample-upload。精确文件边界与请求复现、10项测试、控件浏览器回归见docs/evidence/uat-v21-pr02-upload.md；截图不代表真实登录或OSS联调。创建普通PR后立即加full-gate（UAT P1修复），最终Head通过后最多一次Review。
- UAT-01仍待实际部署请求、单件/批量建档及依赖流程实测；没有生产写入，540件迁移样衣未动。



## 最新进度：PR02 已合并，PR03 施工

- PR02：第一次 Full Gate 34105108294通过；唯一一次 Review 5130319945指出共享上传器消费端 pending 漏拦截，已覆盖全部7处调用并增加回归检查。最终Head 0307ca674c7834d56dfa1c17f5121e492f5803af，第二次Full Gate34106554880通过，Review线程已答复并解决。#415 squash合并SHA587db6a5e44025149e64e547d41ac2227112eb07，已核对merged及远端main。
- PR03：初始只读核验基线cc6d43ac3601765fdf58e4dc5cd5dc9047855c5a，等待PR02时在独立供应商路径施工；最终提交基于PR02合并后的main587db6a5e44025149e64e547d41ac2227112eb07，详情/导入原文件未被PR02修改。范围及合成回归证据见docs/evidence/uat-v21-pr03-supplier-safety.md。
- 没有ECS部署、生产开关调整或生产数据写入；PR01/02代码合并不等于线上UAT关闭。


## 最新进度：PR03 已合并，PR04 施工

- PR03：首次 Full Gate 34107530777通过，唯一一次 Review 5130550291两项P2已修复。第二次34109670897仅旧App滚动源码断言失败，1182项通过；用户收到第三次说明后明确催办继续，推送集中修正。最终Head4d95637518372f8d5520ecd1f252bb8d02f1f3b3的第三次Full Gate34114066370通过，线程关闭，#416 squash合并c5154a86fdd3bf71babe4ec5f11e5c261bb4f71f；merged及remote main均已读取确认。
- PR04：基于上述main集中提交。新普通报价两位有效精度、图片和内部价必填；历史计算/返回契约与延期转厂路径保留。财务逐款金额、摘要与合同展示见docs/evidence/uat-v21-pr04-sourcing-numbers.md。没有改数据库、金额历史、返工、权限或部署配置。
- 已合并不等于已部署或UAT关闭。真实角色、真实OSS及线上业务链仍未补验；UAT-03转厂P1继续延期。


### 2026-09-07 PR05 第三轮授权与合并基线

PR04 #417 已由用户合并，main 为 d58b79eb3ed9ae75a35c3b77c81a20c7c6615ee2。其 Review 历史财务单价显示精度 P2 尚未闭环；修复已保存于提交 10ec2dcf5f4f61ac5d9f5da50cd49917a446ead1，未纳入 main。

PR05 前两轮：首轮参数校验后的类型收窄失败；第二轮类型、构建、1186项常规测试和新增生产排除PG回归通过，旧 sourcing-pr03-postgres 初始化仅到0150导致缺表。保持断言，改用完整迁移manifest。用户已明确授权第三轮；先合入main并解决本台账相邻行冲突，再验证最终Head。尚未触发本PR的Codex Review。

PR06样板源已保存，五尺寸浏览器核验及样板确认尚未完成，未接业务。未部署ECS、未排除生产记录。


### PR06 样板确认与接入

用户已确认样板 95d59a1c885c2e1992ae4bb3263d215b6e958d64。预览环境恢复，已补做五尺寸和草稿离开/只读/空结果/错误恢复核验，见 docs/evidence/uat-v21-pr06-supplier-ui.md。PR05已由用户合并为ee1643b5a1528030a391a3e2542675e166ab7e60；其最终Full Gate34121883047通过，唯一Review请求未返回正式结果，不标为Review通过。PR04历史单价P2仍未纳入main。没有ECS部署或生产数据操作。



### PR07 样板确认与接入

用户明确“我看到了，通过”，批准样板提交39aff78010bfaa14924deff07ec3b412fc603983。基于远端main49e535e53221e68f554266479272eae19f51dfb0接入目录图文行、手机折叠筛选、当前页选择批量归还、详情分组与表单布局；保留真实API、版本、幂等、上传拦截及财务权限。精确范围、测试及限制见docs/evidence/uat-v21-pr07-sample-ui.md。创建PR立即加full-gate，最终Head全绿后最多一次Review。PR04历史单价P2仍未闭环，UAT-03延期P1不变，无生产写入或ECS部署。



### PR08 继续执行与后续UI授权

PR07 #420用户已合并为1e797116712c8aebd0e4dfb9ab5da5de2d6a94f6；Full34129323500及Quick34129312537通过。唯一Review请求5571622307已接单，合并时尚无正式结果，不标记Review通过、不重复触发。业务负责人新增授权PR08—PR13的UI不再逐次确认，Work完成样板、自测后直接接入、开PR、必要Review和合并。PR08样板0b6e02ef4955832ed3e49813d38bae2fa7acb133包含五尺寸与实际浏览器低帧率录屏，URL：https://dx-pr08-production-20260907.lizhonghao31.chatgpt.site 。生产数据和ECS部署边界不变。
