# 2026-10-23 CI 小修：单独授权与验收边界

> 历史执行记录：旧暂停、特批、批次和当时strict比较器只描述当时状态，不是当前施工指令。现行规则见根 AGENTS.md。
用户明确要求本小 PR 只跑 Quick，不发 Codex Review，Quick Gate 通过后合并。这一授权仅限以下三项，不延伸到暂停中的业务 PR。实现基于 release/digital-production-v1 的 cab8412cbd4d0141044f05cd71f2102e874b518f，不包含 PR01/02/03 的业务改动。

1. PR 正文、同模式标题文字等无关 edited：不分配校验 runner、不参与并发取消。GitHub 仍可能保留 skipped 事件记录。打开、代码同步、重新打开、改目标分支及 QUICK/FULL/非法标题之间的模式变更继续校验。并发控制放到选中的 job，两个模式使用同一 PR 分组，合法新任务可以取代旧任务。保留原手动 Quick 入口。
2. Full Gate 完成 workspace build 后直接执行锁定依赖的 `vitest run`，省去 npm pretest 再编译四个包。测试配置、范围、环境和后续数据库验证不变；本地 `npm test` 仍自动预构建。
3. 摘要按各步骤 outcome 报告成功、失败、取消、不适用、上游中断及范围未判定，列未完成的必需检查。未完成风险分类不能当作不需要数据库检查。摘要本身或清理成功不能证明 Gate 通过；宿主被强制终止而无法执行摘要时，以 GitHub Job/日志为准。

Quick 例外由同仓库、唯一工作分支 fix/ci-event-cost-summary、上述固定 base SHA 和五个文件的精确名单共同限制。分支、base 或文件超出范围即回到原风险分类；风险映射文件不改。原 Quick 5 分钟、Full 默认 20 分钟及既有 unified 专项 30 分钟边界均不改。没有拆 job、删除测试、缓存跨 Head 结果、修改保护规则或真实业务操作。

本地先运行 `node --test scripts/ci/gate-maintenance.test.mjs`、Actions policy、改动脚本语法和 diff 检查。Quick 对这个五文件改动识别为治理范围，运行相同定向 fixtures 与治理检查，不安装依赖、不构建应用、不运行数据库或部署演练。事件 fixtures直接执行工作流里的条件表达式并检查 job 级并发位置；并非通过反复编辑真实 PR 消耗 Actions 验证。

可量化收益仅为每次 Full Gate 去掉约 10–13 秒重复构建，以及避免无关编辑重启运行；不承诺由此解决 20 分钟超时。不得借本次授权扩大其他高风险 PR 的 Quick 范围。

关联任务状态：#851 的例外第二次 Review 已由父发起并完成，无重大问题，不再请求。#852 的 47756fc 修复及定向复核保留，Full Gate 39974415616 因 20 分钟超时取消；用户明确接受现有验证并豁免再次全量重跑。该记录不是 GitHub check success，也不授权自动合并 #852。PR03 全部未提交工作保留，业务施工暂停。
