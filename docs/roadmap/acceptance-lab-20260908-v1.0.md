# 达兴数字助手隔离验收中心 V1.1

状态：业务负责人于 2026-09-08 明确批准；本文件记录当前有效施工路线，取代同日较早的 T02/T03 定义。该专项优先于此前供应商/UI优化路线实施。

## 0. 目标

把依赖真实员工逐角色反馈的验收方式，改为由系统维护者自行控制的多身份隔离验收：

- 一个操作者可以使用多个真实 RBAC 测试身份；
- 被测请求必须走正式 AuthService、角色/capability、HTTP Route、Service、PostgreSQL 约束和 Todo 投影；
- 测试身份不得继承 Root；
- 测试数据、附件和通知与正式环境隔离；
- 允许人工切换身份复核 UI，同时支持自动回归和可复核证据；
- 不建设第二套“测试权限逻辑”，不以当前实现反向定义正确权限。

## 1. 当前施工顺序

### T01：隔离验收基座与身份会话（已完成）

1. `NODE_ENV=test` 下显式开启 Acceptance Lab；production 配置直接拒绝该开关；
2. 仅接受 `uat-*` 合成钉钉身份；
3. 独立验收数据库、Root 绑定、外部副作用 fail-closed；
4. PostgreSQL 集成测试证明普通测试角色不继承 Root，真实 Session 读取真实 RBAC。

### T02：验收控制中心与真实角色切换（已完成）

1. `dx_acceptance_control` 与 `dx_rework_session` 相互独立；
2. 一个控制会话可切换标准 `uat-*` 被测身份；
3. 切换后旧 UAT 业务 Session 立即撤销，结束验收后全部 UAT 业务 Session 失效；
4. 一次性控制凭证在 PostgreSQL 原子消费，API 重启/多实例不可重放；
5. `/ui/acceptance-lab` 只在 Acceptance 环境提供，不接入正式业务导航，不改写正式 `App.tsx` AuthGate。

### T03：自动角色权限矩阵（当前阶段）

1. 建立独立、版本化的批准矩阵；批准矩阵不得由运行时 `role_capabilities` 自动生成；
2. 逐个切换全部标准测试身份，核对数据库身份角色、真实业务 Session 角色、Root 标志、应有/禁有 capability；
3. 核对一级业务模块入口及只读 HTTP 权限边界；
4. 允许矩阵明确记录“批准目标但当前实现尚未满足”的失败，例如 2026-09-08 已批准的财务总监样衣只读权限；
5. 业务矩阵不以“当前实现全部通过”为 CI 成功条件，避免把错误实现反向定义为正确；CI 只验证矩阵结构、执行器和安全边界自身正确。

### T04：证据、场景自动化与长期验收报告

1. 在 T03 矩阵结果之上记录版本、身份、预期、实际、关键请求与错误；
2. 对代表性角色组合执行真实浏览器/业务场景，包含菜单、Route、字段、按钮、正常点击与数据副作用；
3. 测试待办使用隔离收件箱，不向真实员工推送；
4. 每条用例状态仅为通过、失败、受阻、未执行；失败重跑不得抹掉首次失败；
5. 输出可由系统维护者自行判断的验收报告，不再以实际员工口头反馈作为唯一依据。

### T04 完成后的施工顺序

先用已建成的验收中心做全角色权限审计与修复，包括但不限于：财务总监样衣只读、返工列表/详情查看一致性、人员权限后台模块分类、角色条件 UI 与订单回货日期/按钮重叠。上述基础治理通过后，再继续供应商目录/维护重构、供应商审批、分析收口和测试订单清理。

## 2. 安全边界

1. Acceptance provider 只在 `ACCEPTANCE_LAB_ENABLED=true` 且 `NODE_ENV=test` 时允许启用；生产配置直接拒绝。
2. 合成身份必须使用 `provider_user_id=uat-<alias>`、`union_id=uat-union-<alias>`；Acceptance provider 不接受真实员工身份。
3. 验收登录码由独立 `ACCEPTANCE_LAB_SECRET` HMAC 签名；控制凭证与登录凭证均必须防重放。
4. 播种脚本只读取 `ACCEPTANCE_DATABASE_URL`；没有该变量立即退出，不允许退回 `DATABASE_URL`；连接后的数据库名称必须再次确认是 acceptance/test/uat。
5. Acceptance 模式不得继承正式 OSS、真实钉钉 Todo 发送、OpenAI 等外部写通道；后续需要附件/通知验收时只能接独立测试资源。
6. 不复制正式员工密码、cookie、token；不冒用真实员工会话。
7. 正式生产数据不用于 Acceptance 写测试；需要复现真实权限时，仅复制权限组合和业务关系条件到合成测试用户/测试订单。
8. Root 正式身份不修改。验收操作者控制测试环境，但普通被测角色必须始终 `isRoot=false`。
9. 角色切换与结束验收必须处理并发：结束控制后不得残留新创建的 UAT/Root 业务 Session。

## 3. 权限矩阵判定原则

矩阵必须同时保存三类事实：

- **批准预期**：由业务规则明确写入版本化矩阵；
- **实际配置**：测试身份当前角色与 capability；
- **实际行为**：真实业务 Session 对模块和 HTTP Route 的允许/拒绝结果。

不得用实际配置自动生成批准预期。发现不一致时报告失败，后续权限治理 PR 再修改正式权限；不得为了让矩阵变绿而静默修改预期。

T03 的自动 HTTP 探针只使用只读接口，不通过 destructive endpoint 做权限试探。真实写操作、状态流转、字段和按钮副作用在 T04 的隔离业务场景中验证。

## 4. Gate 与 Review

- Acceptance 身份、Session、权限执行器属于高风险基础设施，使用 Full Gate；
- PostgreSQL 相关验收必须真实执行，不把 skipped 当通过；
- 每个 PR 的 Codex Review 最多两轮，且仅在业务负责人授权下使用；Codex Review 只读，不允许 coding task 修改分支；
- 一轮 Review 出现有效问题时先自行修复并重跑 exact Head Gate；不得无限 Review 追求理论上的零风险。

## 5. 隔离环境启动约定

标准角色播种：

```bash
NODE_ENV=test \
ACCEPTANCE_LAB_ENABLED=true \
ACCEPTANCE_DATABASE_URL='postgresql://.../dx_rework_acceptance' \
DINGTALK_CORP_ID='corp-acceptance' \
npx tsx scripts/acceptance/seed-role-users.ts
```

Acceptance API 至少设置：

```text
NODE_ENV=test
ACCEPTANCE_LAB_ENABLED=true
ACCEPTANCE_LAB_SECRET=<独立至少32字符密钥>
ROOT_DINGTALK_USER_ID=uat-root
TODO_RUNTIME_ENABLED=false
```

登录仍调用正式 `/auth/mobile`，产生正式结构的 `dx_rework_session`；页面和 API 随后读取数据库真实角色/capability。控制中心入口为 `/ui/acceptance-lab`。
