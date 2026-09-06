# 样衣功能准备核查（2026-09-06）

基线：`b03de21bb427352a7751229db4b0f43c77f78d52`（main）。本轮按负责人指示完善功能并等待下一步，不执行生产写入、切换或 Root 实单测试。

## 核查范围

下表为页面、API 与既有测试代码的静态核查，不代表本轮已运行所有集成测试或完成业务验收。路径分别位于 `apps/web/src`、`apps/api/src/samples` 和 `tests/integration`。

| 业务 | 页面 | 服务及既有集成测试 |
|---|---|---|
| 新增、批量录入、图片与小票 | sample-create-page.tsx | sample-create-service.ts；sample-create-postgres.test.ts |
| 借出、归还、交接确认、二维码、取消、批量归还 | sample-workflow-page.tsx | sample-workflow-service.ts；sample-workflow-postgres.test.ts |
| 出售、赠送、报废、遗失申请及审批拒绝 | sample-disposal-page.tsx | sample-disposal-service.ts；sample-disposal-postgres.test.ts |
| 遗失赔付、基本资料、位置、财务留痕、小票维护、归档恢复 | sample-disposal-page.tsx | sample-disposal-service.ts；sample-disposal-postgres.test.ts |

上述操作已有页面与对应接口；当前写入开关关闭会隐藏操作入口。#412 的详情切换隔离已在前轮部署后完成只读复测，本轮未重复执行或据此宣称写入全链通过。

## 本轮修复

出售、审批最终金额、财务采购价原先直接提交输入，`100` 与 `100.5` 不符合后端两位小数契约。现在提交前以字符串规范为 `100.00`、`100.50`，不使用浮点数或四舍五入。超精度、负数、科学计数法、超范围等输入显示错误并停止提交；金额范围和零值业务规则继续由原契约与服务端执行。附件、原因、版本检查、幂等和权限规则保持原行为。

## 本地验证

- Vitest：`tests/unit/sample-money-input.test.ts`，19 项通过；覆盖三个真实金额契约、边界、非法输入、零值规则和非金额字段保持。
- TypeScript：helper、该测试及引用契约 strict/noEmit 检查通过。
- 修改页面 TSX 转译语法检查通过；此项不等同于完整 web 类型检查或构建。
- 本地未运行完整仓库构建、真实 PostgreSQL 集成测试；提交后由 Full Gate 验证，结果以该 PR 当前 Head 为准。
- 本轮未执行浏览器写操作；五宽度 UI 验收仍按负责人既有指示后置。

## 后续验收

先完成页面、接口和代码验证；负责人发出下一步指示后，在旧系统保持只读、核心对账及备份恢复证据有效的前提下，开放新系统测试窗口。先由 Root 使用明确标识的 TEST 样衣跑通建档、借还、处置、赔付、维护及归档恢复，修复复测后再交普通业务角色验收，最后进入正式使用。测试记录保留审计，不使用迁入的真实样衣做破坏性试验。

现有写入开关是全局样衣业务开关，不是 Root 专用开关；开启后其他已授权账号也具备其原有写权限。测试窗口需按此事实安排，不能宣称已技术隔离普通用户。`businessUatEvidence` 必须如实记录测试准备和当前验收阶段，不得将待执行的 Root 或多角色验收写成已通过。

Root 全链至少覆盖单件/批量建档与附件、借还与交接取消、批量归还、四类处置及拒绝、遗失赔付、资料和财务维护、归档恢复，并逐步核对状态、历史、金额及待办。后续普通角色必须独立验证权限拒绝、财务隔离和真实待办接收；Root 成功不能替代这些检查。完成本轮 PR 后等待负责人指示。
