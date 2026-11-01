# 变更影响与验证证据

长期义务见根目录 AGENTS.md §3。本文件只规定机械格式，不另立审批或重复测试。

每个需要最终Gate的代码变更，在已有执行记录旁保存本 PR 当前的 `docs/engineering/construction-evidence.json`（历史结果留在原 PR/执行记录，不追加第二份当前真源）：`version:1`、实际 `base`、`sourceFingerprint`、`rules`、`checks`。指纹由 `node scripts/ci/construction-evidence.mjs fingerprint` 计算；包含实际源码、配置、测试和未跟踪源码，排除文档，避免补记结果造成自引用。

`rules` 每行包含 `rule/source/writes/reads/oldTests/initialization/dateAndPermission/expectation/checks`。文件可用 `路径#真实符号` 引用；检查同时覆盖旧消费者与初始化，不能只列新增测试。`checks` 引用本记录真实检查ID。

`checks` 每项包括 `id/command/status/exitCode/passed/failed/skipped/testedHead/sourceFingerprint/context/startedAt/endedAt/logSha256`。结果必须来自实际命令及日志；日志可保留在任务私有目录或现有CI中，记录其摘要和定位，不把凭证或原始秘密写入仓库。`not-applicable` 另写具体 `reason`，不得冒充执行通过。失败/未跑先补闭环，不填假绿。

验证：`node scripts/ci/construction-evidence.mjs verify <记录路径> <真实base>`。它拒绝缺记录、旧base、源码漂移、缺调用/旧测试、未覆盖改动文件、无结果凭证及失败/全skip。文档补记形成的新提交，只在实际源码指纹相同且被测提交为祖先时复用本地证据；这不授权跨Head复用最终GitHub Gate。

主控对真实调用链、日志真实性和未声明消费者负审查责任；机械结构不能证明语义完整或零遗漏。现有独立Review不因此再加一轮。源变化时先重跑受影响组合，不用缺字段的表格代替检查，也不为填表跑无关全量。

CI 的 light/最终 Gate 调用 `verify-change <base>`：仅文档差异记录不适用；源码/规则/配置变化必须提交本次记录。没有新记录的旧源码回执不会用于新变更。

测试检查用 `kind:"tests"` 和真实通过/失败/跳过数；lint/type/build等非测试命令用 `kind:"command"`、真实exit及日志凭证，不虚构“1个测试通过”。至少须有一项真实执行测试；此格式不要求每PR全量本地Full。
