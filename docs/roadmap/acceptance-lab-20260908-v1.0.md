# 达兴数字助手隔离验收中心 V1.0

状态：业务负责人于 2026-09-08 明确批准，优先于此前供应商/UI优化路线实施。

## 0. 目标

把依赖真实员工逐角色反馈的验收方式，改为由系统维护者自行控制的多身份隔离验收：

- 一个操作者可以使用多个真实 RBAC 测试身份；
- 被测请求必须走正式 AuthService、角色/capability、HTTP Route、Service、PostgreSQL 约束和 Todo 投影；
- 测试身份不得继承 Root；
- 测试数据、附件和通知与正式环境隔离；
- 允许人工切换身份复核 UI，同时支持自动回归和可复核证据；
- 不建设第二套“测试权限逻辑”，不以当前实现反向定义正确权限。

## 1. 施工顺序

### T01：隔离验收基座与身份会话

交付：

1. `NODE_ENV=test` 下显式开启的 acceptance lab 配置；production 启动配置必须拒绝该开关；
2. 仅接受 `uat-*` 合成钉钉身份的 AcceptanceDingTalkProvider；
3. 短时、HMAC 签名、AuthService 单次消费的登录码；
4. 标准角色验收用户播种脚本，仅允许明确的 acceptance/test/uat 数据库；禁止 `DATABASE_URL` 回退；
5. PostgreSQL 集成测试证明不同身份会话加载真实角色/capability、普通身份不是 Root、权限路由仍独立拒绝；
6. 不发送真实钉钉通知；真实 Todo runtime 在 test 环境继续被配置层禁止。

### T02：权限矩阵审计与缺口修复

- 建立版本化“角色 × 模块 × 页面 × 字段 × 操作 × 待办”批准矩阵；
- 对照数据库实际 role_capabilities、前端入口/AuthGate、HTTP、Service、DB、Todo；
- 修复已确认的财务总监样衣只读权限、返工列表/详情查看不一致、权限管理模块分类落后等缺口；
- 允许和拒绝必须同时测试，禁止通过隐藏按钮替代后端鉴权。

### T03：角色条件 UI 与交互治理

- 修复订单回货无导出权限时的筛选列错位、开始日期无法正常点击/选择等问题；
- 覆盖无按钮、少按钮、多按钮和身份加载前后；
- 验收尺寸：1440×1024、1280×800、768×1024、390×844、360×800；
- 浏览器测试使用正常点击，不使用 force click、直接 DOM 赋值或隐藏遮挡元素绕过可操作性。

### T04：场景自动化、证据与长期门禁

- 多浏览器上下文/多身份业务场景；
- 测试待办收件箱，不向真实员工推送；
- 每条用例输出预期、实际、身份、版本、关键请求、数据库/待办变化和截图/Trace；
- 结果状态仅为通过、失败、受阻、未执行；重跑不得抹去首次失败；
- 角色权限层全矩阵，浏览器层做代表性组合和高风险边界，不做无价值的笛卡尔积。

完成 T04 后再继续此前供应商目录/维护重构、供应商审批、分析收口、测试订单清理路线。

## 2. 安全边界

1. Acceptance provider 只在 `ACCEPTANCE_LAB_ENABLED=true` 且 `NODE_ENV=test` 时允许启用；生产配置直接拒绝。
2. 合成身份必须使用 `provider_user_id=uat-<alias>`、`union_id=uat-union-<alias>`；Acceptance provider 不接受真实员工身份。
3. 验收登录码由独立 `ACCEPTANCE_LAB_SECRET` HMAC 签名，最长 10 分钟，默认 5 分钟；AuthService 继续提供一次性 code replay 防护。
4. 播种脚本只读取 `ACCEPTANCE_DATABASE_URL`，没有该变量立即退出，不允许退回 `DATABASE_URL`；数据库名称必须显式包含 `accept`、`uat` 或 `test`。
5. 不复制正式员工密码、cookie、token；不冒用真实员工会话。
6. 正式生产数据不用于 acceptance 写测试；需要复现真实权限时仅复制权限组合和业务关系条件到合成测试用户/测试订单。
7. Root 正式身份不修改。验收操作者控制测试环境，但被测会话的 userId 必须是对应合成用户，且普通角色 `isRoot=false`。

## 3. T01 预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 944133b173988a32182480153914cfee36b9aaaf
working branch: feat/acceptance-lab-t01
task scope: 建立只在test环境启用的合成身份认证、角色播种和真实RBAC会话验证基座
allowed files: packages/config/src/index.ts、apps/api/src/auth/acceptance-provider.ts、apps/api/src/server.ts、scripts/acceptance/*、tests/unit/acceptance-provider.test.ts、tests/unit/config.test.ts、tests/integration/acceptance-role-session-postgres.test.ts、本文件
forbidden files: 生产数据库迁移、现有角色业务权限、现有业务状态机、ECS/OSS/钉钉生产配置、正式业务数据
```

T01 为身份/权限基础设施变更，PR 必须使用 Full Gate；PostgreSQL 验收必须使用 `TEST_DATABASE_URL`，不得把 skipped 当通过。

## 4. T01 人工使用约定

隔离验收数据库完成迁移后：

```bash
NODE_ENV=test \
ACCEPTANCE_LAB_ENABLED=true \
ACCEPTANCE_DATABASE_URL='postgresql://.../dx_rework_acceptance' \
DINGTALK_CORP_ID='corp-acceptance' \
npx tsx scripts/acceptance/seed-role-users.ts
```

Acceptance API 使用同一隔离数据库，并设置：

```text
NODE_ENV=test
ACCEPTANCE_LAB_ENABLED=true
ACCEPTANCE_LAB_SECRET=<独立至少32字符密钥>
ROOT_DINGTALK_USER_ID=uat-root
TODO_RUNTIME_ENABLED=false
```

生成某个测试身份的一次性登录码：

```bash
NODE_ENV=test ACCEPTANCE_LAB_ENABLED=true ACCEPTANCE_LAB_SECRET='...' \
npx tsx scripts/acceptance/mint-login-code.ts finance-director
```

登录仍调用正式 `/auth/mobile`，产生正式结构的 `dx_rework_session`，之后页面和 API 读取数据库真实角色/capability。T01 先提供可信身份/会话基座；T04 再提供一键切换 UI 和浏览器证据中心。
