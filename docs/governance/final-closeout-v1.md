# 最终启动前的本批收口包

长期入口为根AGENTS V3.1；仅增强原`pr-gate-controller.mjs request-final`，不改CI运行时、权限、保护或流水线。已有引用的观察不要求补包。新引用的preview和apply均在POST之前验证；失败合并输出具体问题，禁止创建引用。

冻结候选、light成功、唯一必要Review及集中修复后，由任务确定的收口负责人完成具体结论，执行者准备外置JSON并运行：

`node scripts/ci/pr-gate-controller.mjs request-final --pr <PR> --head <完整SHA> --closeout /绝对路径/closeout.json`

检查通过再使用同样参数加`--apply`。source/head/base变化需重核；有效的未变输入证据仍沿construction-evidence规则复用，不能旧head回执代新head。包在提交之外生成，不提交、不改head来补写启动状态。

JSON字段：

|字段|要求|
|---|---|
|version|1|
|repository/pr/head/base/baseRef/kind|与实时PR及原控制器plan逐字一致|
|constructionEvidenceSha256/sourceFingerprint|从准确head的现有construction-evidence原始字节与字段取得；原light已核源码/证据，控制器通过原API重读固定head记录，拒绝本地替换|
|decision|具体本批结论，20–4000字符；不冒称可验证作者身份|
|review|原reviewFor的required与reviewedHead；不需Review时理由/授权逐字一致且有界，不能豁免FULL或已有Review|
|findings|固定已知发现；id/source/status=closed/conclusion/checkId/testNames。GitHub Codex已知发现还需reviewCommentId；不可遗漏。人工发现完整性由收口负责人负责|
|scopeChecks|每条construction规则至少一个ruleIndex（从0开始）、固定id、来源、closed结论与该规则checkId/testNames；无发现仍须具体核验，不能空集合放行|
|noFindingsReason|本批确无发现时的有界结论，不是省略Review|
|reports|每个checkId提供path/sha256/format，或files数组（分组运行可有多个真实结果，合计数须一致）。读取真实普通文件及construction中原命令log，核实际摘要；同时解析原命令结果和TAP/Vitest JSON报告、总数和具体通过用例。重复结果、失败/全跳过/名称不匹配拒绝|

报告不采用自填passed证明。TAP需真实`ok`用例及pass/fail/skip总数；Vitest JSON需success及真实passed assertion fullName。原命令日志有用例名称时，报告的全部通过名称须与其逐一一致，不能仅总数相同。只有汇总数字的命令日志，必须在捕获该次执行时将结构化报告的`format/sha256`登记到同一check的`resultReports`，提交内固定摘要须与实际报告逐一一致；事后找一份同数量报告不能补证。每项finding/scopeCheck引用其中具体通过名称，不支持“已检查”。check总数须匹配原construction记录。低风险纯规则/文案/素材自动测试不适用时，原记录必须给具体理由，可用`command-record`实际退出记录；该出口不能替代业务/权限测试。

缺记录、旧head/base、未闭合和有效只建一次均在原控制器入口测试，另有实际报告篡改、固定head记录替换、遗漏Review发现、全跳过反例。协议测试先行，不用业务Full调试协议。

边界：本地包/报告摘要不证明生产者身份或语义覆盖全部缺陷；本工具不认证“父级身份”。直接手动建合法ref仍可绕过本地启动工具，本次不另建远端传输/存储/认证系统。旧窗口需明确通知、fetch实际目标分支并使用新入口，不声称仅合并规则就自动更新所有窗口。
