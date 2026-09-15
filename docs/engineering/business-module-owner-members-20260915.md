# 2026-09-15 老板成员分权交付口径（PR03）

## 基准及范围

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `85d3c6665f2375ba15edbfd01903711301ab5a9c`（PR02 #481 合并）
- working branch: `feat/0915-member-module-policy`
- Gate: `[FULL]`
- 仅实现本轮需求 R04/R05；允许修改成员策略、对应读取/操作入口、待办投影与投递重核、迁移、测试及本文档。
- 不修改真实身份、不部署、不操作生产业务数据；样衣、板房、供应商中心及工资规则保持。

## 规则与实现

`0184_business_module_owner_members.sql` 新增最小配置 `business_module_owner_bindings`，只有三个固定成员键和稳定内部用户 UUID。迁移不预置真人账号、不按姓名运行授权、不新增配置页面。

| 已核实成员 | 返工/外发读取 | 业务写入 | 本轮模块待办通知 |
|---|---|---|---|
| 李仲豪 | 保留合法范围 | 保留原合法操作及老板审批 | 保留既有合法路由 |
| 伍云峰 | 保留合法范围 | 拒绝，兼职角色及旧委派不能绕过 | 不新建、不继续提醒或投递 |
| 李俊岳 | 现有 Root | Root 原生能力 | 保留 Root 路由；独立高倍率确认没有其他合法老板时仍可承接 |

名单启用后，其他后来加入老板组的成员不会自动获得这两个模块的老板审批资格；其非老板审批操作继续走原规则。任一合法审批人完成仍按原待办前缀共同结束，不增加会签。

数据库函数分别表达 `member_module_can_write`、`member_module_can_notify`、`member_module_owner_can_approve`。实际 Root 身份优先。`operation_events` 的增量触发器在业务事务内拦住两个模块的业务写入，操作失败全部回滚；绑定切换与业务审计写入通过事务锁排序。审批和待办的直接角色判断也叠加成员策略。

会话保留原 `capabilities` 读取兼容性，另返回 `effectiveWriteCapabilities` 和 `readOnlyModules`。这是因为部分既有 GET 接口复用业务 capability；不能删掉读取所需标记。前端按模块只读状态关闭发起、补图、判责、报数、核价、特批、合同补充、派单及生产填报等操作；历史事实、凭证、照片预览、导航和独立导出授权仍按原规则读取。

HTTP `preHandler` 对当前注册的返工与外发写路由重新读取会话策略；GET/HEAD、读取确认、附件下载及 OCR 提取不被归为业务写入。即使旧页面保留按钮或直接调用服务，数据库业务事件仍拒绝越权。独立供应商维护路由不在限制范围。

## 既有待办与通知

绑定服务 `MemberModuleBindingService` 默认 dry-run，明确 apply 后在同一事务内保存三个绑定和审计、取消伍云峰两个模块未结束待办。绑定不可被重复执行覆盖；相同绑定可安全重跑。

- 取消复用 `TodoService`，保留任务及来源事件，记录权限调整原因，产生原生远端结束消息。
- 仍有效的老板审批检查当前业务状态；已有正确接收人的任务不复制，缺失的按原来源与共同结束前缀补建。陈旧任务只收口，不重开审批。
- 投影前过滤接收人；发送/提醒前重新核验；升级通知沿来源待办识别业务模块。已排队新建消息被抑制，远端结束消息继续发送。
- 不删除原审批人、历史签字、金额、凭证、已完成记录或其他模块待办。
- 绑定不能撤回已经投递的消息；已有远端任务由正常终态投递及重试收口。真人钉钉结果仍需部署验收。

## 真实账号绑定（部署前必须核实）

本轮没有取得三人的真实内部 UUID，也没有写入生产绑定。代码合并、迁移通过不代表真人分权已启用。

先在明确的目标环境只读核对三人的内部用户 ID、主组织有效身份、老板角色及既有 Root。姓名仅用于定位；重名、多身份、别名冲突必须人工核实，不自动选择。脚本会检查三个 ID 不同、每人一个有效主组织身份、李俊岳是原 Root、另外两人是有效老板。

使用已编译的 API，`DATABASE_URL` 必须是操作者明确选择的环境。以下参数名后的文字需替换为核实的 UUID，不是真实绑定值：

```sh
node scripts/bind-business-module-owners.mjs \
  --root-user-id ROOT_UUID \
  --li-zhonghao LI_ZHONGHAO_UUID \
  --wu-yunfeng WU_YUNFENG_UUID \
  --li-junyue LI_JUNYUE_UUID
```

默认只输出身份、受影响待办 ID 和未发送通知数量，不写入。核对输出并保留变更前报告后，同一命令追加 `--apply --verified-identities` 执行已核实绑定。确认普通会话刷新后的 `readOnlyModules`、写接口 403、历史读取正常、合法老板仍有待办，以及钉钉旧任务结束。

不得填写猜测 UUID；若已有不同绑定，脚本拒绝覆盖，须独立核验修复。回退前端代码不能当成恢复操作权限；持久策略和历史事实须保留。

## 验证范围

当前完整业务链增加真实 N08 待签字场景的绑定切换、旧任务收口、伍云峰拒绝和李仲豪正常签字。独立 PostgreSQL 场景覆盖旧会话 HTTP 读取/拒绝写入、真实外发审批、兼职角色、Root、后来加入的老板、其他模块策略以及 Fake DingTalk 的已发任务结束与未发消息抑制。

本地 PGlite 用于完整 schema 与业务场景反馈；真实 PostgreSQL、并发及迁移门禁以当前 PR Head 的 Full Gate 为准。Fake DingTalk 不等于真人端接收验收。

常规检查：`npm run lint`、`npm run typecheck`、`npx vitest run`、`npm run build --workspaces --if-present`、`npm run db:migrate:lint`、`npm run secret:scan`。线上部署不应在低配置 ECS 重跑 Full Gate。
