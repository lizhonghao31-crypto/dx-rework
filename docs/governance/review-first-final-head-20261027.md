# Review-first 与最终Head协议 V3

现行执行政策见[根 AGENTS](../../AGENTS.md)。本文件是已实现协议说明，不是某轮PR、暂停或历史豁免的授权。

## 自动验收与人工决定

本页描述默认自动验收。用户明确要求合并时，按根AGENTS §4的人工合并路径核真实对象、Head/base和授权范围，保留检查及Review的真实状态，再使用正常合并入口；不把尚无成功Final Gate视为对用户决定的额外否决，也不将失败记录改成通过。

`verify-merge`继续只核自动验收批准，其代码契约不变，不用于生成或伪装人工授权。人工合并仍受平台工具审批、服务端分支保护和身份权限约束；工具拒绝或结果不确定时先核事实、报告并停止该动作，不能借修改本地规则或换渠道规避该次拒绝。

## 每PR一次Light

仅PR首次opened且run_attempt=1执行Light。后续任何变动、重开和重试不重跑Light。最终Quick/Full直接验证当前Head，不要求当前Head另有Light；失败或缺失的初始Light不冒充通过。Full无可用同Head产物时执行全部原检查；复用仍必须核准来源。

## 请求与核证

`node scripts/ci/pr-gate-controller.mjs request-final --pr <N> --head <Head40> --closeout <外置收口包>`只读核真实PR、当前目标tip、必要Review及[本批收口包](final-closeout-v1.md)；preview/apply均在新建引用前校验包、固定Head的construction摘要和实际报告，已有授权内加`--apply`创建唯一请求：

`gate/{quick|full}/{PR}/{Head40}/{base40}/{baseRefBase64url}`

它指向真实候选Head，不是PR合并ref、main或合成提交。既有ref/发送不确定先核状态，不force/update/delete、不加nonce。CI只执行选择的worker，证据中保留实际run/job/attempt。

`verify-merge --pr <N> --head <Head40>`核完整tuple和实际成功任务、回执、必要Review线程闭环；最后重读Head/base/mode拒绝漂移，合并用expected完整Head。源代码内核证工具不是服务器branch protection；不可见的保护设置不能猜测，也不在本流程修改。

## Review与恢复

本地必要验证及完整 diff 组装完成、PR 创建后，首次 Light 与必要 GitHub Codex Review 并行启动：Light 由 opened 自动启动；单一控制者核已有同 Head 请求后，按已有授权请求一次 Review，不等待 Light 结论。Review 不是额外 Actions job，不新增 runner、凭据或写权限。两路结果都收齐后集中修复，再冻结最终 Head 和实际 base、请求最终 Quick/Full；记录 Light SHA、被审SHA与最终SHA，不冒称后者又审过。源码/模式/权限的新风险按实际授权处理，不把纯偏好扩大成新增工程。

`watch-review --pr <N> --head <Head40> --request-id <ID> --watch --apply --review-retry-authorized --state-dir <private-dir>`使用已存在的15分钟恢复授权。时间从请求的服务端created_at起，先核已完成/新请求/在途状态，防重复发送；本地锁只对同一控制者有效，不能冒充跨机器互斥。拒绝和不确定写入保留journal，先只读reconcile，不删除锁或另换发送通道。

低风险Quick确实不需Review时，协议允许带`--review-not-required --review-reason <理由> --review-authorization <已有授权来源>`。这不授予豁免；Full、已经开始/失败的Review或未关闭finding不能被此声明抹掉。

## 并行边界与最终收口

`ci.yml` 的 Light 仅受 PR opened/首次 attempt 条件约束；Codex Review 由现有 GitHub Review 服务独立处理，不在该 workflow 的 job 依赖图内。`pr-gate-controller.mjs` 的 `reviewStep` 不读取 Light job，`requestFinal`/`verifyMerge` 仍调用必要 Review 核证及线程闭环。无需修改 workflow concurrency；现有 Light 与最终 Gate 的同 PR 排队保持，防止重复资源消耗。

并行只缩短 Light 与 Review 的串行等待，不减少任何检查。已知 Light/Review 发现进入同一修复及外置收口包；不得把运行中、失败、旧 SHA 或未闭合 Review 当作通过。新实质风险沿原协议处理；原正常一轮 Review 及恢复防重复规则不变。Full 复用 Light 仍要求最终 Head/base 与源成功产物完全匹配；发生修复导致不匹配时执行原检查，不为复用补跑 Light。

## 执行与复用证据

`Final Gate exact Head`来自实际选择worker成功及结构化回执，旧Head、skipped、空跑或失败不能作为自动验收批准。普通检查记录`executed`；同Head采用已成功light检查时记录`verified_reuse`及源run/job/attempt、上下文与产物指纹，操作者与当前已核light再对照。仅复用真实同语义项，详见[Actions政策](github-actions-usage-policy-v1.0.md)。最终Gate本身仍在当前请求中真实认证；用户人工决定不改变这些检查事实。

CLI使用现有授权身份，日志重定向/凭证失败保持原错误。支持的连接器可读取原始GitHub事实，再调用相同纯协议核验，但必须分别记录该证据路径，不能声称CLI已经成功；不得更改代理、凭证、安装权限来绕拒绝。只读GraphQL的POST传输不等于写Review。

集成以本任务真实base→candidate为准；Acceptance以真实独立DB→candidate，生产晋级另核准确main与实际生产ledger/应用语义。旧strict comparator自举、旧批次审批与旧环境重建仅保留在历史记录，不作为以后普通PR的强制前置。

工具版本、worker与预算读取本分支权威配置，不在本说明复制数值。收到暂停后记录在途实际状态并安全停止；恢复从短状态和真实Head/运行续接，不重开同一分支、Review或CI。交付注明实际merge/tree和失败/未测范围，不把现场历史只读结果当作当前新写链验收。
