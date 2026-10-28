# 网页版 ChatGPT Work 施工流程 v2.1

状态：长期有效  
适用仓库：`lizhonghao31-crypto/dx-rework`  
更新日期：2026-10-27

本文件只描述执行流程；长期红线和业务来源以根目录 `AGENTS.md` 为准。

## 1. 默认分工

当前 ChatGPT Work/助手是默认控制器和执行器，负责方案、施工、定向验证、PR 修复和交付。Codex 默认仅做独立 Review；除非业务负责人对当前任务明确要求 Codex 编码，否则不得调用 Codex 施工。

## 2. 唯一施工流程

1. 一次预检仓库规则、授权目标的真实远端 base SHA、相关 PR 与 Head；记录允许/禁止范围、原测试健康、入口/读取消费者及失败/回滚/重试/并发矩阵。
2. 完成同范围定位、配套代码/测试、定向验证和完整 diff 自查。已知未完成不得推送。
3. 一次 push assembled candidate，标题使用 `[QUICK]` 或 `[FULL]`；先取得当前 Head 的 **Push light checks** 实际成功。
4. 发起必要 GitHub Codex Review。收齐审查发现和同范围自查遗漏，在本地集中修复/验证，再一次推送修复 Head；不为每项 finding 单独跑昂贵 CI。
5. 冻结最终 Head，通过 `scripts/ci/pr-gate-controller.mjs request-final` 先只读核验，再在授权内显式创建唯一最终请求。仅选定 Quick/Full 实际执行，保留现有风险分类、检查和预算。
6. 最终 Gate 真实失败先读完整日志及同类问题，集中修复后新 Head 再验；不得用旧 SHA 或 skipped 同名检查放行。
7. `verify-merge` 只读核 current Head、真实 base tip、模式、实际 Review/线程闭环、真实 run/job/attempt 与执行回执；当前授权内用 expected Head 合并，核 merge tree 与候选一致。此工具不更改 GitHub 保护设置，也不代表已有硬门禁。
8. 串行任务须当前 PR 实际合并后才从新基线开始下一 PR；普通已授权步骤不重复问用户。动作被拒或不确定时准确报告动作/目标/原因/执行状态，不换路径绕过。

具体协议、读权限和平台限制见 [Review-first 操作说明](review-first-final-head-20261027.md)。

## 3. 两种推进模式

### 逐 PR 验收
当前 PR 达到可合并状态后等待业务负责人确认，再开始下一 PR。

### 全程接手
业务负责人明确授权后，助手在授权范围内连续完成施工、门禁、Review 修复及获授权的合并；普通可处理阻断不得导致无故停工。

两种模式都不改变生产数据、密钥、Root 边界等安全红线。用户说“停”立即停止。

## 4. Gate 分类

### QUICK
适用于纯文档、低风险文案/CSS、隔离测试维护以及未改变接口、状态、权限、数据口径的小修改。

### FULL
适用于 migration/schema、权限身份、财务金额数量合同、核心状态机/审批/审计/幂等、跨模块关键链路、部署/Actions/基础设施、共享平台能力、P0/P1。

PR 创建前必须完成分类：
- 两种等级 push 都只先跑轻检查；
- 最终 `[QUICK]` 选择 Quick，`[FULL]` 选择 Full，不重复选两个重检查。

当前 Head 变化后，只认新 Head 的 Gate 证据。

## 5. Push 纪律

- GitHub Remote 不是调试器。
- 已知未完成的配套修改不得分批 push。
- 代码 + 测试 + migration + manifest 等属于同一修复时，一次准备完整后提交。
- Gate 运行中不继续“顺手改”；只有真实阻断已经定位并完成集中修复时，才更新 Head。
- 同一 Head 的失败 Job 最多 rerun 一次；再次失败先修根因。
- 禁止 noop commit。

## 6. Codex Review

Codex Review 是审查渠道，不是施工渠道。高风险 PR 默认需要独立 Review，低风险 PR 可不请求；具体按当前任务授权执行。

正常审核默认一次。用户长期要求：从请求发出满15分钟仍无结论视为异常，先核已完成/新请求，再重开一轮；不伴随 push 或 CI，服务错误不算通过，不确定/拒绝发送不盲重试。审查期间保持实际 Head 与请求时间可见。Review 后由当前助手集中修复，记录实际审核 SHA 与最终 SHA，不冒称再次审核。

## 7. 汇报格式

用户问“可以合并了吗？”时，只回答：

- `可以合并`；或
- `不能合并：<唯一具体阻塞>`。

阶段检查点及用户问进度时，报告：最近完成命令/计数、当前真实操作、剩余项与精确阻断；活动中至少每分钟一次有效说明。不要用 SHA、内部路径、重复日志淹没业务负责人，除非版本错配本身就是阻塞。

## 8. ECS 维护

多步骤高风险维护命令必须使用独立脚本执行，不能把可能 `exit` 当前 Shell 的脚本体直接粘贴到登录会话，也不能 `source`。Acceptance 更新只做与当前 diff 对应的最小操作，不在 ECS 上运行 CI/Full Gate。

Acceptance阶段统一读取 `docs/operations/acceptance-lab-runbook-v1.0.md`。A1首次canonical切换完成后，不再重建ENV；后续A2/A3/A4按固定批次流程执行。控制码失效、浏览器404、角色矩阵失败分别属于控制层/入口层/业务验收层，必须按层定位，禁止直接回退到“重部署整套Acceptance”。

## 9. 收尾与效率复盘

保存最终 Head、真实 run/job/attempt、Review 请求/结束和 findings 闭环、merge SHA/tree、明确已跑/失败/未跑范围。复用无新变化的已过检查；昂贵检查只在冻结 Head 显式请求。记录必要验证与可避免返工、重复运行的次数和实际耗时，不以缺失日志推测编码工时/Fast速度。部署和业务复验是独立授权状态，CI全绿不能替代。
