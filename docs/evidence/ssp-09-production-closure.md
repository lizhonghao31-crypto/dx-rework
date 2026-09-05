# SSP-09：实时生产待办、回货关联与试点收口

## 施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 8a19ddadf251b3b28fefd542d960ea184739ca4d（PR #401 已合并，预检开放 PR 为零）
- working branch: feat/ssp-09-production-closure
- task scope: 复用实时生产风险口径，接通个人待办、仓库实际回货和供应商试点开关。
- allowed files: apps/api/src/sourcing/production-{closure,dashboard,reporting}*、sourcing-routes.ts、server.ts；apps/api/src/todos/{service,routes,deep-link}.ts；apps/api/src/receiving/receiving-{service,routes}.ts；apps/api/migrations/0151_sourcing_production_closure.sql 与 migration-manifest.json；packages/contracts/src/{index,todos,production-closure}.ts；apps/web/src/{my-todos-page,platform-access,production-closure-ui,production-dashboard-page,receiving-page,todo-indicator-refresh}.*；对应 tests/unit、tests/integration 及 scripts/run-business-chain-gate.mjs 的新用例注册；本证据。
- forbidden files: 已发布迁移、财务流程/审批、返工业务规则、样衣、ERP 适配/数据、部署配置和密钥；不修改全平台 UI Golden Source。
- Golden Source: sourcing-supplier-production-v1.0.md 的 SSP-09、12.7 和 rework-ui-golden-source-v1.0.md；既有控制尺寸、样式和分页直接继承。

## 实现边界

- 我的待办新增实时生产模块。共享 SSP-08 的 SQL 事实读取与工作日/自然日计算，首次有效上报前无风险；已完成/发货不再产生预警。
- 风险接收人是对应跟单、生产管理、老板和原身份体系的 Root。按用户集合判断、多角色只显示一次；财务、仓库、普通报工或纯系统管理员身份不因此获得生产监督任务。
- 同一订单仅一个当前风险投影，按已有 stale > high_risk > behind 优先级展示。唯一索引和事务锁使重复观察幂等；风险种类改变、解除后再次出现形成新一期提醒。
- 上报、Root 修正、完成、发货在原事务内同步更新本单风险投影，保证两次上报间即使没人查看也能记录解除。日期自然推进由既有待办列表/角标读取时重算，不新增后台定时器或看板轮询。
- 阅读只插入当前用户的已读记录；其他人的未读不变，风险待办仍保留。列表数字为当前风险数，顶部角标只增加生产未读数；进入详情后立即通知既有角标刷新。无钉钉 outbox、升级催办或额外审批。
- Root 在实时看板设置按供应商试点，默认关闭。启停记录审计，同值重试不重复生成事件。关闭立即撤销当前风险投影、停止新的收货关联，历史保持可读；正式派单、正常生产和原有收货不受开关影响。
- 复用 SSP-07 发货事实提供预计回货。仓管在现有订单回货页面主动选择具体发货单（款号、供应商、合同编号、发货日期用于区分），只预填首款款号，按现场填写送货单和实收数量；保留原有多次收货/补录分类。
- 实收与关联在同一事务提交，原有幂等请求哈希仅在选择发货单时增加生产订单 ID。数据库外键和守卫保证一条收货记录只关联一张已发货订单、首款一致、实收日期不早于发货、审计对象与生产订单一致。校验失败整体回滚。
- 不根据款号自动关联：同款号跨供应商/生产订单时必须由仓库明确选择。发货不创建 receiving_receipts、不改成仓库已收货、不增加第四种生产状态。
- 生产详情显示已关联的仓库逐条实收记录，采用该条最新收货修订；归档批次显式标记。批次级汇总调整不臆分摊给生产订单，仍以原订单回货页面为准。不把发货数量冒充实收。
- 生产待办、发货选项和回货 DTO 使用白名单；不含价格、达兴价、合同银行资料。供应商中心不增加生产进度或生产历史。

## 验证

- 本地 61 项定向测试通过：看板计算/筛选、角色允许与拒绝、身份去重、个人角标口径、模块权限、搜索/分页、旧待办列表与 HTTP 路由。
- contracts/domain/config/ui 构建、API/Web 类型检查、修改 TS/TSX lint、Web 生产构建通过；未升级依赖。
- 新增全 schema PostgreSQL 用例，已注册到原 Full Gate 业务链脚本：从供应商资料、节点 1、IE、节点 3 工艺/选厂、老板批准、合同生成、无财务核对派单，到填报/修正/完成/重复发货和实际收货。覆盖三家合成工厂、试点隔离、财务拒绝、风险新周期、按人已读、并发幂等、首款拒绝、错单拒绝、关闭后历史保留和无价格泄露。
- 本地无 PostgreSQL，上述两个数据库用例为 skip，必须由本 PR 当前 Head 的 Full Gate 执行，不算已通过。
- 新 0151 的 SHA256 与 manifest 一致；旧迁移及 manifest 条目不改。完整仓库迁移回放由远端执行。
- 当前会话云浏览器对本地预览已返回 ERR_BLOCKED_BY_CLIENT，不绕过安全策略。未取得新版截图，构建和代码测试不代替部署后的视觉/UAT。

## 三家试点 UAT 数据与人工验收

自动化夹具使用以下独立合成资料，不读取 ERP 或生产数据；可在隔离验收环境按同样数据录入。

| 工厂 | 订单明细 | 试点状态 | 验收目标 |
| --- | --- | --- | --- |
| 试点厂1 / SSP09-1 | RISK-A 蓝20件、RISK-B 白10件，首报5件 | 开启 | 高风险、个人已读、错误首报撤销解除、新风险重新未读、三天未更新、完成后关闭 |
| 试点厂2 / SSP09-2 | RECEIPT-A 蓝20件、RECEIPT-B 白10件，完成25件 | 开启后关闭 | 预计25件，首款关联实收24件再追加1件；重复请求只一次；关闭保留历史 |
| 试点厂3 / SSP09-3 | OFF-A 蓝20件、OFF-B 白10件，完成25件 | 关闭 | 可正常生产发货，但不产生试点待办或可选回货关联 |

- 1440×1024、1280×800、768×1024、390×844、360×800：检查待办模块、搜索分页、长供应商名、已读标签、试点选择、发货选择与原收货表单对齐、键盘操作和手机按钮。
- 同时登录对应跟单与老板：跟单点入只消自己的角标，老板仍未读；填报恢复正常后两人的风险待办关闭。
- 财务仅在后续对账时核对；无财务操作仍可完整派单/生产/发货/仓库收货。普通报工、仓库和无授权角色看不到价格及生产风险待办。
- 发货后实收列表为空；仓库选择正确订单并录入实收后出现实际记录，检查另一张同款订单没有串联。

## 交付门禁与回滚

Full Gate 必需，当前 Head 全绿后由业务负责人手动触发一次 Codex Review。PR 创建后立即交接，不自动 Review、合并或部署。

回滚优先关闭试点，再向前修复或回退应用；保留新增表、已读/风险历史和实收关联，不删除生产事实或仓库记录。数据库采用增量迁移，普通未关联收货的既有参数和行为保持不变。

## Full Gate #986 初始化修复

- 精确失败 Head：04912a8a9a816b8982dc01df332ee2c2faa9aee2。lint、typecheck、构建、普通全量测试、迁移升级、收货与 Root 回归通过。
- 唯一失败套件为新增 production-closure-postgres.test.ts：全量迁移前未创建 schema_migrations，迁移读取历史时触发 42P01，两条新用例未执行。其余业务链 103 项通过。
- 修复测试初始化：按既有完整业务链夹具创建版本历史表，每个迁移及其 version/checksum 在同一事务提交；保留全部迁移和全部业务断言。应用代码及已发布迁移不变。
- 修改文件 ESLint 和生产闭环定向单测通过；真实 PostgreSQL 结论以修复 Head 的第二轮 Full Gate 为准，不以本地 skip 代替。

## Full Gate #987 后续初始化修复（待授权验证）

- 迁移历史问题已解除。第二轮仍在新用例 beforeAll 创建工艺时失败：fixture 将 sourcing:view 作为创建工艺审计 capability，而现行守卫要求 master_data:manage 或 sourcing:decision:record。
- 一并核验供应商资料创建路径，发现它还需要真实的组织身份、有效角色授权和公司策略；原夹具只创建 app_users，不足以通过完整 schema 的受控主档写入。
- 修复夹具：按既有 full-business-chain 的 bootstrap 顺序建立合成账号身份/角色，随后 ensureOrganizationPolicy；工艺和供应商创建使用 master_data:manage 的受信动作上下文。不修改 Root 身份、业务权限、生产代码或数据库守卫，不停用触发器。
- 两条 SSP09 新数据库用例仍未取得实际运行通过证据。PR 默认两次 Full Gate 已用满，第三次需业务负责人按 AGENTS.md 第11节明确授权后执行。
