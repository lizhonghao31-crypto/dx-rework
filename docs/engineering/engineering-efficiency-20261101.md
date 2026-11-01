# 2026-11-01 工程效率治理：执行契约、范围与兼容意图

用户 09:11 UTC「ok」、09:12 询问三项目标后 09:13「好」，批准一个独立治理 PR 验证并合入 release；09:15 明确要求机制性解决多次漏接清理器。按当前明确委派执行此工程任务，覆盖默认 main 施工基线；最终仅合 release，不部署、不推进暂停的 #882，不恢复 PR04。

## 一次预检与边界

- repository: `lizhonghao31-crypto/dx-rework`
- base: `release/digital-production-v1`，实际远端 `53fb44e8a56db8464027de65f7016aca16822638`（#881）
- main: `1de4bb07d24d4eb98913a7dcfc528ef984ebe359`（#879）
- branch: `chore/engineering-gates-20261101`；FULL，独立 worktree `/workspace/dx-gates`
- 允许：测试执行/夹具资源接线、CI 风险/实际回执、Acceptance 验证策略、对应文档规则。
- 禁止：业务 API/UI/contracts/财务权限逻辑、已有 SQL/checksum、生产/Acceptance 数据/权限/凭证、main 合并、部署、branch protection。
- 原健康证据：#881 最终 Head `7332f5a0`、Full `41279368078` 和精确 Head 认证成功；完整 2936 通过、944 条件跳过，mapped/PG13/Root/业务链 406、恢复/历史/生命周期/包均有实际执行记录。只读 #882 的 `docs/engineering/new-flow-20261101-authorization.md`（69–179）核对失败与消费者，不重跑旧失败 Head。

## 三项机制与验收矩阵

| 目标 | 实现及允许/拒绝边界 | 验收证据 |
| --- | --- | --- |
| local/CI 一致 | 同一 `test-suite-plan.mjs`、同一 `test:postgres`；明确 suite 文件集、配置、DB 实际 OID/角色/版本及子进程 env；先原生协议/全仓时间索引、源码/静态迁移、DB 初始化和资源 smoke，再直接影响/长链；非 DB 在发现阶段排除 PG | 原生协议正反例；local plan 与 workflow 命令相同；完整非 DB、PG 实际执行及最终 CI 分开记录 |
| 漏接清理器 | 创建、manifest、清理共用一个 registry；新/修改创建入口要求接入，未知前缀 CREATE 前拒绝；manifest 必须有当前 run、32hex、精确文件名、实际测试库身份；真实失败子进程后 finally 精确清理、查询无残留；大型 teardown 共享事务 advisory lock，失败回滚/释放；清理失败保留 manifest | 全 registry 正例；未知 prefix/别名、其它 run、OID 漂移、无 marker 库、错误已标记库均拒绝；default/Acceptance-clock 真实双库 |
| 一次真实执行 | mapped/chain/Root 显式并集，每文件只一次；Root 原隐式导入移到共享组合；后续步骤核同一 run 逐文件 JSON 结果及成功清理 | 重复文件只一次；全 skip/缺失/重复结果/失败/不同 PG、角色、Head、base、attempt 均拒绝；PG13 独立执行保留 |
| 精确风险 | migration+checksum-bound inventory 保留真实升级、Root/ACL、低权限、多版本维护及恢复；维护/备份、激活、打包传输分别选；未知部署执行器保守全测 | inventory-only 不选激活/包；真实执行器仍全范围；协议与 YAML/认证同源正反例 |
| 兼容意图 | integration 必须实际冻结 release base→candidate；Acceptance 固定 launcher+实际自身 ledger/身份/权限；production 仍严格 main 来源、真实 production history、支持源版本与必要应用行为 | main 独立新增允许集成/独立 Acceptance，明确 TODO/production 未验证；production intent 拒绝；实际未知 identity/checksum/历史缺口拒绝；实际离线 Acceptance 控制链保留生产健康/锁 |

原 Node 协议与 Vitest 是两个集合；不得用「本地几千项」代替不同入口。`npm test`/CI 广泛套件共用默认非 DB discovery；PG 只在显式 `DX_REWORK_TEST_SUITE_KIND=postgres` 的 canonical runner 中启用。现有长正确性套件沿 60s 配置，新增 PR03 技术历史套件路径预先绑定该配置；默认/性能用例没有全局放宽。

历史上未接入集中 registry 的独立旧测试保持原实现；一旦新建/修改或纳入受管整链，便宜接线检查要求先迁入同一 API。为避免无关旧 fixture 修复扩包，本 PR 不把所有历史 PostgreSQL 用例都变成 mapped，也不声称它们已运行/通过。所有现有 `ownedPostgresSchema` 前缀统一受 registry 拒绝规则保护。

## 当前本地结果与真实失败

- Node 22.22.2/npm 10.9.9；隔离 PG16-alpine，`dx_rework_test` 无超级用户/建库/建角色/复制/BYPASSRLS，两个库均有原安全 marker；不连接任何现场数据库。
- 原生便宜协议 107 项通过、无 skip；4 个受影响 Vitest 文件 45 项通过；workspace typecheck/build、Lint、静态迁移校验已通过。
- 实际 release base 初始化、Head 迁移校验通过，checksum 漂移/删除迁移拒绝；串行清理后 15 条历史升级＋1 条低权限权限维护共 16 项通过（67.82s）。真实失败子进程资源 smoke 及跨 run/OID/无 marker 保护通过。
- 初次把所有历史 schema 命名统一接入时，额外带入无关旧 fixture 的映射，暴露 `manual_access_disabled`/`receiving_batches` 缺失；该扩包已撤回，未修改业务来适配。该次 33 文件执行 22 失败/11 成功，失败不算通过。相同次还暴露并发大型 DROP 的 `out of shared memory`；本 run 的 56 个精确资源清理成功，已对受管整链及直接相关 fixture 统一事务串行清理，不加 PG 锁参数。
- 广泛非 DB 首次 531 文件中 529 通过/1 失败/1 跳过，2927 通过/1 失败/11 跳过；唯一失败为旧离线控制链仍断言 main 新增必须阻断 Acceptance。已改为验证独立 Acceptance 成功、production 状态不变、main 差异明确待办且 productionPromotionVerified=false；生产不健康拒绝用例保留。不能把该失败写成全量通过，修复后定向/最终 Head 另记。

## 本地/CI 操作契约

```bash
npm run test:preflight
# 用真实冻结 BASE_SHA 生成路径集合并导出 risk env（CI 使用相同 classifier）
node scripts/ci/full-gate-risk-map.mjs --github-env "$risk_env" "$changed_files"
# 新鲜、带 marker 的低权限 default/clock 两库；先执行原 seed-base-migrations 和 migration check
NODE_ENV=test node scripts/test-preflight.mjs --database
# 非 DB：清空泛 URL 和专库变量，原 workspace build 只一次
TEST_DATABASE_URL= ACCEPTANCE_CLOCK_TEST_DATABASE_URL= node node_modules/vitest/vitest.mjs run
# PG：BASE_SHA、TEST_DATABASE_URL、ACCEPTANCE_CLOCK_TEST_DATABASE_URL 和分类 flags 已导出
# CI run/attempt 自动绑定；本地必须显式设置本次唯一执行 ID，不将 worktree 回执当交付认证
export DX_REWORK_TEST_EXECUTION_ID=<local-run-id> DX_REWORK_POSTGRES_RECEIPT=<temporary-receipt>
npm run test:plan
npm run test:postgres
node scripts/run-business-chain-gate.mjs --full-gate --verify-receipt
```

回执仅在所有计划文件实际成功且清理成功后写 passed；绑定实际 PG 版本/角色/库 OID、Node、配置、Head/base/run/attempt/本地执行 ID。不同 PG13、低权限维护及恢复演练不去重；CI 最终认证仍核完整 exact tuple 与所有适用实际步骤。

## 本治理自身的原/新门禁

本 diff 改 workflow/执行器，原有效规则下全部维护、恢复、历史、生命周期、发布包仍适用。冻结候选后额外从原 base 提取未改的 strict main comparator，对最终完整 Head/tool SHA/真实 base 检查；不借新 integration intent 豁免原保护目的。最终仍按原 Review-first：本地→一次 assembled draft push→light 实际成功→GitHub Codex Review→集中修复→冻结 Head→显式 Full→核证授权合 release。保留旧失败，不提交 APPROVE review。

## #882 交接与发布边界

本 PR 不携带 #882 的业务/0268SQL。#882 同步后保留其 fixture 已有的 Acceptance-clock 选库、seed/schema 和清空泛 URL；共同 `ownedPostgresSchema(prefix, 'acceptance-clock')`、`createOwnedPostgresSchema(pool, schema)` / `dropOwnedPostgresSchema(pool, schema)` API 已支持，不需要再维护 runner 前缀正则。技术历史测试已在共享 long-correctness 配置中登记，但只有 #882 合入其文件才实际存在/执行；此处不声称已跑该未合套件。同步时应保留业务 fixture 改动，使用治理的共享 registry/runner/Root 组合，不恢复旧独立白名单。

PMC SQL 已在 release 的事实保持原 checksum；其应用层部分403仍是独立上线待办。本任务不顺带移植 PMC、赋权、撤迁移、部署或将源码兼容冒充完整应用兼容。

收益来源是提前截获契约失败、相同套件只执行一次、非 DB 不 import 大量 PG 套件、迁移 inventory 不再触发无关激活/打包、业务集成不追无关实时 main。未给固定提速比例；真实耗时、执行次数、最终 Head/Review/run/job/attempt/merge/tree 在 PR 外部证据回执保存，避免为追加已发生 CI 结果再造新 Head。

## 提交前补充回执

收窄范围后的实际并集测试：默认配置 9 文件84项通过；长正确性配置17文件327通过/1失败，失败仅为新清理 helper 错误释放调用方借出的 Client，54个精确资源仍清理成功。已改为只释放 helper 自己从 Pool 获取的连接，调用方 Client 保持可用；该真实失败不算全链通过。修复后原 own-tail 历史＋资源契约2文件6项通过，Root/供应商/双库接线4文件11项通过。新的 canonical runner 用同一资源文件重复输入及 own-tail 两个文件实际执行6项，成功清理后跨进程核回执；原生协议107项通过。离线 Acceptance 控制链及相关 guards3文件8项通过（158.13s），含原22条 Python控制/中断子场景。最终完整并集由最终Head的显式 Full再次证明，不能拼接局部结果冒充当前完整链绿。

首次 assembled 提交 f00acb73 后核对发现 `vitest.config.ts` 未包含在显式 git add 范围，实际本地已验证的 discovery 配置仍在 worktree。立即在 Review/Full 前补齐该文件与原生配置契约断言，不把首个 light 候选当最终证据；不重跑未变化的业务或 SQL 演练。

同范围自查补齐 `npm run check`：workspace build 一次后直接运行非 DB Vitest，再只运行显式配置的 PostgreSQL 整链，避免原 root postbuild 的13个静态测试和 npm pretest 重复。无 TEST_DATABASE_URL 时明确输出 DATABASE_NOT_VERIFIED，不称 DB 通过；CI Full 不使用此本地静态已执行标志。共享入口的独立原用法仍保留静态验收。

## 独立目标核验的五项集中修复

GitHub Codex Review实际审核 `47a2a5495daac0f853a3cee4a546a9c26d2c2a62`，回执6556312283于09:49:12Z完成、无finding。其后独立目标覆盖核验发现五个真实契约反例，刚启动的 Full41295025017/attempt1已取消，不能当通过。以下同一批修复后冻结新Head，保留原实际审核SHA与最终SHA，按 Review-first 不把修复后提交冒称再次审核。

1. 受支持的 G1旧工具显式check/install入口也传 `--intent acceptance`。新增组合覆盖 main新增＋旧工具＋check→explicit install→diagnose→update；在同条真实离线控制链中，注入目标实际导出未知identity/checksum漂移均在备份/PM2之前硬拒；生产指纹始终不变。原生产准确main来源规则不改。
2. 资源创建改为 `createOwnedPostgresSchema(queryable, schema)`：只有本进程注册生成、实际DB身份匹配的资源才能发DDL。受管/新修改消费者的每个裸CREATE均拒绝；正则不再以文件包含某关键词作整体豁免。同文件先受管再裸建history schema、大小写/跨行CREATE和未生成资源均有负例。原精确manifest清理与跨run/双库拒绝保留。
3. Full PG入口要求完整风险flags、mapped集合及不可变base。需DB却空计划或缺上下文硬拒，结果验证本身也拒空集合；确无DB范围输出not-applicable并使旧回执失效，不签PG passed。便宜纯函数和实际CLI反例＋正常双文件6项执行/回执核验均覆盖。
4. 无显式BASE时预检相对HEAD取差异，包含暂存与未暂存，再并入untracked；临时Git库正例覆盖三种状态，CI显式base仍原样绑定。
5. 兼容报告只要有issues就明确 `BLOCKED_INVALID_SOURCE`；production缺main/漂移不再同时给source-compatible状态。exit1和原历史守卫保留。

集中验证：原生协议110项无skip；4个unit文件31项；实际PG4文件22项（含15历史、低权限、资源及原own-tail）；旧工具/advanced-main组合2个Python用例32s均通过。统一入口重复mapped输入只执行两个文件6项，清理通过并跨进程核回执。完整22场景离线控制链与最终新Head Full另记，未把局部结果拼成全量成功。

#882 必做的最小同步：当其真实 `tests/integration/development-technical-postgres.test.ts` 存在时，必须加入 `scripts/test-suite-plan.mjs` 的 **POSTGRES_CHAIN_TESTS**（不只LONG_CORRECTNESS_TESTS），并让其 business-anchor/其它新增fixture使用共享创建API、保留Acceptance-clock目标与seed/schema绑定。治理分支没有该业务文件，不伪称已执行；仅预登记60s不满足接入完成。原窗口同步时保留其业务/SQL，解冲突采用治理共享registry/runner，不恢复旧名单。本任务不操作暂停的#882。

CLI日志重定向403的准确阻断保留；依既有Review-first说明，用授权GitHub连接器取得实际light job124811617885的唯一结构化回执，原纯协议核实际run/job/Head/base/Review后请求Full。没有改token、网络或仓库权限，不宣称原CLI命令成功；这与后续实际Full结论分别记录。

本批最终补充：完整离线控制链1文件2条Vitest包装、原22个Python场景均成功，158.87s；新增旧工具/main组合另覆实际导出历史为空拒绝，独立21.51s成功。原生110项、PG22项、unit31项、后补状态断言和非空canonical回执均通过。提交仍不改业务源码或SQL。修复后的light/Full使用新Head；原GitHubReview的47a2a549与无finding事实保留，不宣称新Head获第二次Review。

创建防漏的后续定点复核补充：同文件裸CREATE已经拒绝，但实际TS源码中的反斜杠换行转义仍可能漏；之前测试把转义预先变成换行，未覆盖原源文本。预检现保守归一化源码中的换行/字符/Unicode/hex转义和相邻常量拼接，再禁止消费者裸DDL。新增 String.raw 保留真实源文本的反例（另含String.raw消费者、Unicode、hex及身份转义）；原生协议111项无skip通过，不做任何扫描删除。其余已关闭四项不重复审查，无新增Full/Review；修复仅便宜反例后新Head light与最终Full。

该补充提交的脚本误将本交接文档写成测试源码；提交后完整diff核对已发现，恢复此前全部证据与本段追加记录。测试源码与DDL防漏修复本身保持原样；不把该文档误写候选作为最终交付。

最终 Full41296812316/attempt1 在安装前预检真实失败：111项Node协议均通过，后续静态migration lint因共享migration-lib顶层导入未安装pg而ERR_MODULE_NOT_FOUND；安装/DB/整链未执行，summary失败为连带结果，不能当通过。最小修复只把pg加载移到原applyMigrations入口，Pool配置、SQL、事务/锁/回滚和历史断言完全保留。新增无node_modules源快照的静态校验回归；原生112项、实际DB迁移集成（checksum漂移/删除拒绝）通过。提交后在独立无依赖干净worktree按Full安装前阶段运行完整preflight，再push新Head，不重跑失败旧Head。
