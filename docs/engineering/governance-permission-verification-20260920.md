# V4 权限专项：接手验证与增量回归

## 本次基准及范围

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `d390048a12da4d1f5f6439046c265c9bfa196c6f`
- working branch: `test/v4-permission-closure-20260920`
- task scope: 承接治理 PR01/#538、PR02/#539，复用 PERM-01—05 的已有实现和有效验证证据，补齐兼岗及供应商撤权回归。
- allowed files: `tests/integration/helpers/receiving-difference-authority-scenario.ts`、`tests/integration/supplier-onboarding-postgres.test.ts`、本文。
- forbidden files: 业务源码、历史迁移、权限 Golden Source、工资/数量/金额算法、UI、部署及真人配置。
- gate class: FULL；最终 Head 通过后请求一次独立 Review。

本次业务权限的唯一金标准为仓库内 `docs/requirements/platform-permission-golden-source-v1.0.md`（以下章节均以当前 main 的该文件为准）：

- PERM-01：`2026-09-16 回货差异处理（APPROVED）`。
- PERM-02：`2026-09-12 财务中心与统一工资增量（APPROVED）`、`PERM-ROLE-FINANCE-READ-001`、`PERM-ROLE-FINANCE-DIRECTOR-001` 及第 4、5 节字段/导出白名单。
- PERM-03：`2026-09-15 老板成员在返工、外发的增量分权`，执行说明为 `docs/engineering/business-module-owner-members-20260915.md`。
- PERM-04：`2026-09-12 供应商维护与申请确认` 及其引用的 `docs/requirements/supplier-onboarding-20260912.md`。
- PERM-05：文件开头 `板房职责更新（2026-09-15）`、`2026-09-12 首次打板流程（APPROVED）`、`2026-09-12 板房价格管控（APPROVED）` 及其引用的 `docs/requirements/pattern-room-finance-v1.0.md`。

本文的 PERM-01—05 是验证分组标签，不是另一套权限规则，也不恢复金标准文件中的历史施工顺序。保持岗位职责、Root 特例和真实业务数据。

## 已有证据与本次工作

复用 #539 最终 Head `24452503a1037051054607331e3af557c26891da` 的 [Full Gate 35515495582](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/35515495582)。已读取步骤和实际日志：隔离 PostgreSQL、迁移与业务链确实执行，业务链 28 个文件、243 个测试通过。这是自动化证据，不是生产岗位验收。该次独立 mapped PostgreSQL 步骤跳过，不将所有独立数据库套件记作已执行。

| 专项 | 已有验证证据 | 本次增量／保留边界 |
| --- | --- | --- |
| PERM-01 回货差异与数量 | 完整业务链调用 `exerciseReceivingDifferenceAuthority`：两名跟单处理两类差异；仓管等单一角色拒绝；数量不自动变化；撤权拒绝；Root 修正 | 新增仓管显式兼任跟单后的允许、数量修正拒绝、撤销跟单后旧身份拒绝及无额外记录验证 |
| PERM-02 财务、工资、特批 | 完整业务链包含财务角色持久授权、统一 HTTP 工资查询/结清/XLSX、板房财务范围；另有 `finance-wage-access`、`shared-report-wage-access` 等接口回归通过 | 复用既有证据；不把财务读取扩大为特批、不改变结清标记或算法；真人页面与凭证仍需岗位验收 |
| PERM-03 指定老板成员与待办 | 业务链导入 `member-module-policy-postgres.cases.ts`，覆盖稳定 ID 绑定、旧会话、兼岗、返工/外发拒绝、合法审批、通知收口与虚拟生产待办 | 代码及合成身份有证据；真人绑定是否已实施未知，不能由代码合并推定；不写入真实账号配置 |
| PERM-04 供应商申请与维护 | 现有 `supplier-onboarding-postgres.test.ts` 导入维护套件，已有申请范围、防重、审批、回滚、并发测试；#539 对此独立套件为 skipped | 在现有套件增量验证申请人和审批人撤权后旧身份读写/幂等重放均拒绝，正式供应商及业务审计无越权新增，剩余合法审批人仍能完成；本 PR 按 #539 映射要求真实运行供应商套件 |
| PERM-05 板房职责与范围 | 完整业务链覆盖板房/尾部独立角色、显式兼岗、撤权、本人任务、转交、历史执行段、财务读取与 Root | 复用现有测试；未把自动化测试扩大为真人资料/移动页面验收 |

开裁的角色限制及价格字段裁剪、样衣和生产相关测试亦存在并在本次承接的业务链中有运行记录；这不构成其他模块全部权限已经收口的声明。

## 增量回归的完成标准

1. 仓管单一角色不能处理差异；明确兼任跟单后两类差异均允许，但仍不能修正已录实收/装箱数。
2. 撤销兼任跟单后，即使请求携带旧跟单身份，两类差异也拒绝；数量和已有历史事实不变，不新增被拒操作的处理记录。
3. 供应商申请人撤权后，旧身份不能读本人敏感申请、列申请、复用旧提交键或新建申请。
4. 审批人撤权后，旧身份不能读待审批资料或同意/退回；申请保持待审批，未产生决策或正式供应商，也没有成功业务审计。
5. 另一有效审批人可以继续正常审批，只产生一个正式供应商。
6. Full Gate 必须实际执行映射到的供应商 PostgreSQL 套件及完整业务链；Quick 不执行。静态 skip 不是数据库通过。

## 验证与交付口径

本地使用 Node 22、当前源代码及隔离内存 PGlite 做定向反馈；PGlite 不等同真实 PostgreSQL，也不用于证明真实并发性能。真实数据库结果以本 PR 最终 Head 的 Full Gate 为准。测试结果、Gate、Review、合并与部署分别记录在 PR。

没有找到确定的业务权限缺陷时，只补回归证据，不为五个专项机械创建五个修复 PR。本次修改不需要真人再次授权或日常填报。

生产待核验项：明确部署版本；指定老板稳定账号绑定及旧待办实际收口；普通岗位页面、资料和移动端操作。现有绑定工具默认 dry-run，使用说明见 `business-module-owner-members-20260915.md`。不得猜测 UUID 或借本次测试直接执行生产绑定。

优势：将已确认岗位边界加入可重复执行的回归，并复用已有 CI 证据。限制：自动化不能证明真人绑定和生产页面已生效；需要在实际部署验收阶段分别核对。
