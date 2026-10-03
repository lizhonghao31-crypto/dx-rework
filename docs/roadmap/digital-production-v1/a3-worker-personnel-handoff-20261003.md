# A3 Acceptance 内部工人档案最小交接

## 范围与当前证据

基线 `release/digital-production-v1@209b00854c217c9fd2e5a6bbc0f5096c0016df0a`，
分支 `fix/acceptance-worker-person-check`，FULL Gate，独立 draft PR，不合并、不部署。
本工具不是部署步骤，不自动接入启动、迁移或更新流程；不触碰生产库。

QA 确认既有非 Root `pattern-room-worker` 的 app_user_id 为
`1494c445-fe65-4c24-95cc-72620360adb6`。技术主管在原打板派工中搜不到该师傅；
原打板待分配，故师傅报车板完成被正常业务门禁阻止。
普通 UI 新增临时人员不能关联既有登录账号，不能建同名 temporary 冒充内部师傅。
线上是否确实缺记录、停用或冲突，仍须部署后执行本工具只读检查确认。

PR607 已包含标准人员 seed helper，但 `acceptance-update-flow.sh` 与
`update-acceptance-local.sh` 不调用 `seed-role-users.ts`。代码更新成功不等于人员 seed 已执行。
没有在线 seed 执行记录，不能把推测写成已证实的执行遗漏，也不能据此报新业务回归。

## 为什么不默认重跑全量 seed

`seed-role-users.ts` 遍历全部标准 UAT 账号：缺身份时新建用户/组织身份；已有用户会
更新 display_name、enabled=true、manual_access_disabled=false，更新组织身份
active/employed/last_verified_at；必要时补标准角色，初始化新库 Root/组织策略，
并补三个标准工人的 business_people。因此它不是“只补一个人员档案”。
本次不默认执行该全量脚本，也不执行会创建 TEST 母单的其他 fixture seed。

新入口 `scripts/acceptance/check-worker-people.ts`：

- 默认只读，连接启用 default_transaction_read_only。只接受显式 ACCEPTANCE_DATABASE_URL，
  禁止 DATABASE_URL 回退；配置及实际数据库名均需 Acceptance/UAT/test token。
- 要求 NODE_ENV=test、ACCEPTANCE_LAB_ENABLED=true、明确 DINGTALK_CORP_ID，
  以及已初始化且有效的 UAT Root。绝不 bootstrap、启用账号或授予角色。
- 检查既有标准身份、有效组织身份、标准有效角色、额外角色/委派、人员冲突。
  任一检查失败即停止；停用/冲突不会被自动修复。
- `--apply` 才通过 PR607 原有 helper 和审计服务创建缺失的 active/internal 人员，
  绑定真实 app_user_id；已有正确档案不写入。只选择明确 alias 时只处理该人。
- 不改旧 TEST 订单、原打板状态、数字任务、工资、账号或角色。不是业务派工替代品。
- 各人员创建独立事务；多人员执行中断可只读复查后幂等重试，不宣称全批次原子性。

## 未来由用户执行的最小操作

等待用户批准合并并按既有流程部署到 Acceptance。使用已审核发布源码目录及已安装的
Node22/npm10/tsx，以 Acceptance 专用运行用户执行；源码通常位于
`/opt/dx-rework-acceptance/build/update-<实际部署SHA>`。先确认工具存在及 SHA 对应本次交付。
不要在生产目录、生产配置或 main 上执行；不要把示例参数当真实凭据。
单独配置 Acceptance 的 `ACCEPTANCE_DATABASE_URL` 和 `DINGTALK_CORP_ID`，不打印连接串。

只读检查（退出0=就绪，2=缺档案，其他非0=守卫/错误，必须先查明）：

```bash
# 在独立 shell 中运行；两项变量需事先由用户从 Acceptance 专用配置明确设置。
: "${ACCEPTANCE_DATABASE_URL:?请明确设置Acceptance专用连接串}"
: "${DINGTALK_CORP_ID:?请明确设置Acceptance组织ID}"
NODE_ENV=test ACCEPTANCE_LAB_ENABLED=true npx --no-install tsx \
  scripts/acceptance/check-worker-people.ts --check \
  --alias=pattern-room-worker \
  --expected-user-id=1494c445-fe65-4c24-95cc-72620360adb6
```

确认报告仅为该既有账号缺档案后，用户显式执行一次：

```bash
NODE_ENV=test ACCEPTANCE_LAB_ENABLED=true npx --no-install tsx \
  scripts/acceptance/check-worker-people.ts --apply \
  --alias=pattern-room-worker \
  --expected-user-id=1494c445-fe65-4c24-95cc-72620360adb6
```

随后重跑同一 `--check`，确认 ready=true，唯一 personId 对应上述 appUserId。
如果检查为冲突/停用/缺角色/不同账号ID，不执行全量 seed 或直接 SQL 绕过。
本次最小解锁不需要补 worker-a/worker-b；不带 alias 可只读检查三人，apply范围要另行明确。

业务继续由技术主管正常分配原打板；数字预派不会自动替代原打板派工。
旧 NONE 原打板 `4eb799a7-c8de-4985-adaf-72742bc1e342`、新 TEST 原打板
`57bfc0c3-0c9a-4038-b744-90f0902be71c` 及后续 DUAL 的原单均按原记录复测，
不复制新单冒充旧问题已验收。依次推进车板→尾查→当前样板确认→P12/P13正链。
P14 两张原订单读取需包含 #622 的代码部署后另行现场复测。

## 本地验证和边界

使用独立 loopback PostgreSQL 13.23、全 schema 与合成 UAT 身份，真实服务/审计触发器：
检查不写入；最后一人身份停用时零建档；expected-user-id 错误时零建档；指定板房师傅
仅建一人；随后全量补三人及重复执行幂等；用户/身份/角色全行快照保持一致。
CLI 配置测试覆盖默认只读、明确 apply、错误参数、生产模式/数据库拒绝、禁止连接回退。
回归加入既有 business-chain 测试列表，不改变 Gate/部署策略。

P12/P13/P14 另在 #622 最终 Head `6f6f87a5d469fdbb30a13ab5f9ea7580b9722e49`
复用现有全schema、多角色业务服务测试，PG13.23执行
`vitest run tests/integration/sourcing-pr03-postgres.test.ts -t 'P12|P13|P14'`：
5通过、51未选。覆盖P12自裁/外裁权限、原PO实裁聚合、幂等及更正；P13无二次工艺/印花、
工艺/QC/仓库/跟单正链和拒绝；P14零事实读取、回货、装箱、正常/例外结案、版本及并发保护。
业务操作采用实际非Root角色，原测试保留Root建立夹具、指派/更正等明确边界。
这些是本地服务层+数据库证据，不冒充真实登录浏览器或线上业务链已通过。

建议合并顺序 #619→#620→#621→#622→本工具，各自基于同一release基线、文件无重叠，
没有强制顺序依赖。全部仍为draft；用户未来决定合并并统一部署一次，再执行上述单人补档。
