# 最终启动前的本批收口包

长期入口为根AGENTS V3.1；复用原`pr-gate-controller.mjs request-final`；仅 Full 增加下述托管原入口前置，不改权限或分支保护。已有引用的观察不要求补包。新引用的preview和apply均在POST之前验证；失败合并输出具体问题，禁止创建引用。

冻结候选、保留首次 Light 的真实结果、一到两轮必要 Review 及集中修复后，由任务确定的收口负责人完成具体结论，执行者准备外置JSON并运行：

`node scripts/ci/pr-gate-controller.mjs request-final --pr <PR> --head <完整SHA> --closeout /绝对路径/closeout.json`

检查通过再使用同样参数加`--apply`。source/head/base变化需重核；有效的未变输入证据仍沿construction-evidence规则复用，不能旧head回执代新head。包在提交之外生成，不提交、不改head来补写启动状态。

JSON字段：

|字段|要求|
|---|---|
|version|1|
|repository/pr/head/base/baseRef/kind|与实时PR及原控制器plan逐字一致|
|constructionEvidenceSha256/sourceFingerprint|从准确head的现有construction-evidence原始字节与字段取得；首次 Light 不要求成功或匹配当前 head；控制器通过原 API 重读固定 head 记录，拒绝本地替换|
|decision|具体本批结论，20–4000字符；不冒称可验证作者身份|
|review|原reviewFor的required与reviewedHead；不需Review时理由/授权逐字一致且有界，不能豁免FULL或已有Review|
|findings|固定已知发现；id/source/status=closed/conclusion/checkId/testNames。GitHub Codex已知发现还需reviewCommentId；不可遗漏。人工发现完整性由收口负责人负责|
|scopeChecks|每条construction规则至少一个ruleIndex（从0开始）、固定id、来源、closed结论与该规则checkId/testNames；无发现仍须具体核验，不能空集合放行|
|noFindingsReason|本批确无发现时的有界结论，不是省略Review|
|reports|每个checkId提供path/sha256/format，或files数组（分组运行可有多个真实结果，合计数须一致）。读取真实普通文件及construction中原命令log，核实际摘要；同时解析原命令结果和TAP/Vitest JSON报告、总数和具体通过用例。重复结果、失败/全跳过/名称不匹配拒绝|

报告不采用自填passed证明。TAP需真实`ok`用例及pass/fail/skip总数；Vitest JSON需success及真实passed assertion fullName。原命令日志有用例名称时，报告的全部通过名称须与其逐一一致，不能仅总数相同。只有汇总数字的命令日志，必须在捕获该次执行时将结构化报告的`format/sha256`登记到同一check的`resultReports`，提交内固定摘要须与实际报告逐一一致；事后找一份同数量报告不能补证。每项finding/scopeCheck引用其中具体通过名称，不支持“已检查”。check总数须匹配原construction记录。低风险纯规则/文案/素材自动测试不适用时，原记录必须给具体理由，可用`command-record`实际退出记录；该出口不能替代业务/权限测试。

缺记录、旧head/base、未闭合和有效只建一次均在原控制器入口测试，另有实际报告篡改、固定head记录替换、遗漏Review发现、全跳过反例。协议测试先行，不用业务Full调试协议。

边界：本地包/报告摘要不证明生产者身份或语义覆盖全部缺陷；本工具不认证“父级身份”。直接建合法ref仍绕过本地包核验，采用新策略的 Full 仍需独立通过托管检查；合并核证照常核 Review。旧窗口需明确通知、fetch实际目标分支并使用新入口，不声称仅合并规则就自动更新所有窗口。

## Full 受影响原入口

采用该规则的目标基线从自己的 `scripts/ci/affected-entry-map.json` 选适用用例。控制器比较冻结 Base 和 Head 的完整树，保留删除与重命名的旧路径。不受影响的不要求该用例，本地未在真实原文件中通过、仅用新版入口、跳过或换基线的报告不能发起 Full。带选择用例的 check 使用准确候选的 `sourceFingerprint`、同候选谱系的 `testedHead` 和已有已固定摘要的 Vitest JSON，可记录绝对 `cwd` 以从不同执行目录核原报告里的测试文件；仅标注名称或手写通过状态不算。其它有效报告仍可以按已有规则复用。

GitHub 对唯一 Full 请求从冻结 Base 普通 Git 对象读取验测策略，独立用实际差异选同一批具体业务用例，在正常的浏览器配置与隔离 PostgreSQL 下运行。没有受影响项时仍留下准确的空匹配回执，但不安装依赖或启动浏览器/数据库。适用用例缺、失败或跳过时，昂贵的 Full worker 不开始。合并核证核 GitHub 同一次 run/attempt 的真实 job、步骤与原始回执，不依赖正文、手填状态或同名旧检查。按原规则已获准的一次瞬态重试复用原 run，重新执行同一次 attempt 的定向检查；不跨 attempt 搬用旧回执。

这不是所有 Full 用例的前移。包和托管证据只覆盖登记了可追溯影响映射的原入口。首次引入策略时旧 Base 还没有策略，不追改旧请求或已有运行。以后新增映射应说明现有调用方和对应真实用例。

### 托管 Review 与逐项测试

Full 的同一个预检 job 在安装、浏览器及 PostgreSQL 准备前，用已有 Actions
只读身份核 GitHub PR 当前 Head、真实 Base、独立 Review 和分页后的线程状态。
允许第二轮后修复的提交保留原 Review 结论，不需要第三轮，也不把该提交说成已审。
GitHub 的 resolved 只证明线程已解决，不证明修改及实际测试已过。

逐条发现以真实 bot 原评论、审查提交和 GitHub 已解决线程为准。早一轮原问题文件确实变更、且之后独立 Review 完成时，复用后续 Review。最后一轮不要求第三次 Review，也不在发布基线预登记未来评论的字句或摘要。预检核原问题文件从受审提交到冻结 Head 的实际源码修改，自动选取同一修复差异中新增或改正文的标准有名 PostgreSQL 回归。测试必须直接引用被审模块，或与它同属目标 Base 已有的原入口映射。没有关联的有名用例、重复用例、关线程但实际源码未改、作者自报通过均不放行。

这是从真实改动选测，不推断测试足以证明所有语义。已有入口映射继续按实际 Base→Head 影响选取。普通有名测试不需登记评论或测试名；通过辅助模块间接消费的入口沿目标 Base 的既有影响映射识别。暂不识别动态拼出的名称或参数化生成名称，覆盖此类发现时使用真实的有名回归。候选仓库不能用自己的映射或报告声明跳过。其中同一改动选择的原入口与 Review 用例合并，只运行实际选择的用例一次。

预检只执行合并选中的精确命名用例，验证并保存原始结果，记录真实
run/attempt/Head/Base、Review 核验内容及报告摘要，Full 必须等这一 job 成功。
合并核证使用 GitHub 同次实际成功 job、留存步骤和回执，并独立复核冻结范围、
Review、真实修复差异和同次用例回执。目标 Base 继续固定选测程序和原入口规则，候选不能为自己登记免测。缺可信证据时补回归，不开重复 Full 或第三轮 Review。
