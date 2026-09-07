# UAT/UI/数据升级 V2.1 执行台账

## 当前接手事实（2026-09-07）

- repository: lizhonghao31-crypto/dx-rework
- route: PR01 规则收口与导航图标
- base branch: main
- base SHA: e0f1681dfa8d6007b3a682bc4b80b660e5914ebf（本次远端实际读取，与附件历史快照恰好相同）
- working branch: feat/uat-v21-pr01-rules-icons
- task scope: 版本化已批准变化，提供复用现有Shell及图标组件/CSS的可点击样板，确认后才接壳。
- UI sample status: 待业务负责人确认；不得提前接入生产App。
- required gate: 最终共享壳接入后Full Gate；当前仅规则、未接入图标组件和隔离样板。确认前不把样板提交当最终intended Head，不提前触发Review。
- review/merge authorization: 本轮Work自行判断并触发必要Review（所需Gate全绿后、每PR最多一次），修复、合并和继续；覆盖手动Review/合并和PR创建后结束的流程默认。样板确认、部署与生产数据边界不变。

### 远端进度

本次开放PR查询为空；按创建时间检查最近已合并PR为#413（样衣金额输入与独立验收顺序）、#412（切换详情隔离）、#411（迁移对账）。本轮计划目标路径尚不存在；当前代码仍以圆点/文字作为导航图标，没有本轮图标映射，PR01未实施。规则索引“样衣尚未开工”“SSP-08待建设”已过期，本次按远端代码和规则修正；不重做已完成代码。

GitHub读文件、读取提交、PR和CI元数据以及Git对象写入通道已暴露；本次工作分支已成功创建，不以账号admin标志代替实际写入证据。直接HTTPS git读取缺少终端凭证，采用已连接的GitHub API，不寻找旧工作树、不切换Codex Cloud。浏览器已连接，样板使用独立合成数据。完整仓库Node22/npm10门禁与ECS部署不由当前Node24临时编译结果替代。

部署SHA、登录状态、当前生产开关及本轮业务验收尚未核验，不能因PR合并或历史UAT报告而标记本轮通过。样衣生产切换仍遵守独立验收、最终证据、对账与备份保护；不通过开关模拟Root测试模式。

### PR01精确文件边界

本次样板阶段允许修改：

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

确认后在同一PR01另行冻结接壳精确路径（预计components.tsx、共享NavigationItem类型及实际二级入口/标题文件），不以此预计路径作为提前写入授权。样板阶段仅对构建时虚拟模块添加图标，磁盘上的原Shell、原UI组件和生产导入不修改。样板选择器与示例详情不会进入生产。

禁止修改：apps/api/**、任何数据库迁移/生产数据、既有返工业务页面及状态/数量/金额逻辑、钉钉及Root权限、.github/workflows/**与CI治理脚本、部署配置、依赖及锁文件、PR02—13业务实现。许可文本仅随SVG图标保存，不引入运行时图标库。

## 固定路线台账

| 路线 | 状态 | 下一步 |
|---|---|---|
| PR01 规则收口与导航图标 | 施工中；样板待确认 | 样板确认后在同一PR接壳并跑Full Gate |
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
