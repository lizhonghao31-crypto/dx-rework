# AGENTS.md

## 2026-09-07 本轮已批准增量规则

当前 UAT/UI/数据升级路线以 `docs/roadmap/uat-ui-data-upgrade-v2.0.md`（正文 V2.1）及 `docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md` 为入口，固定 PR01—PR13。该计划是业务负责人明确批准的版本化变更：节点一订单图片和样衣采购小票必填；跨模块统一基础 UI 参数，不强制统一业务布局；图标及业务布局先交可点击样板确认。已验收返工不重排，仅添加获批导航/标题图标。

本轮 Work 获授权自主判断并触发必要 Codex Review（最终 intended Head 所需 Gate 全绿后，每 PR 最多一次）、修复和合并并继续路线；覆盖下文手动触发、合并及创建 PR 后结束本轮的流程性默认。样板确认、部署与生产数据保护仍按本轮计划及当时明确授权执行；不是永久授权。

本文件约束所有在 `dx-rework` 仓库内施工的网页版 ChatGPT Work、Codex Review、其他 Agent 和开发人员。除非 PR 明确获得业务负责人批准，不得绕过。

## 1. Golden Source

1. GitHub `main` 是唯一代码 Golden Source。
2. 业务规则以 `docs/requirements/startup-requirements-v1.2.md` 为当前确认基线。
3. 样衣模块以 `docs/requirements/sample-system-migration-v1.0.md` 为一期业务、权限、数据、UI、迁移与验收 Golden Source。
4. 外发定价、供应商中心、合同、正式派单、生产填报与实时看板以 `docs/requirements/sourcing-supplier-production-v1.0.md` 为一期 Golden Source。
5. 当前平台化路线、规则隔离和新窗口读取入口以 `docs/roadmap/platform-2.0-rules-index-v1.0.md` 为准。
6. 返工模块已运行的 UI 基础参数是全平台现有页面与未来开发的唯一 UI 参数 Golden Source，详见 `docs/requirements/rework-ui-golden-source-v1.0.md`；覆盖所有 UI 参数及同类交互，不限导航。
7. Figma 基础库和 Product 是基于返工基线同步的设计与验收载体，旧数值不能覆盖返工实际实现。
8. 聊天记录、截图、口头意见不能直接覆盖上述基线；需求变化必须先形成版本化文档或 ADR。

## 2. 每次施工前的强制预检

开始任何修改前，必须输出并记录：

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: <本次任务由 GitHub/Codex 平台实际注入或从远程 main 读取的基线 SHA>
working branch: <本次实际工作分支；Codex 托管任务可为平台注入的 work 分支>
task scope: <一句话目标>
allowed files: <允许修改的明确路径>
forbidden files: <本次不得修改的路径>
```

要求：

- 网页版 ChatGPT Work 是本仓库长期、唯一默认的施工入口。其运行目录可能是 `/workspace/scratch/...` 且没有 `.git`；这是正常云端工作形态，不构成初始化失败。此时以 GitHub `main`、目标 PR/branch 元数据以及 GitHub 返回的 blob/commit SHA 作为预检证据。
- 网页版 Work 不得扫描、比较或复用运行环境中偶然可见的历史克隆、旧分支和旧工作树；scratch 中的临时文件不是代码 Golden Source。
- 同一任务的远程基线预检只执行一次。只有施工期间 GitHub 出现与本任务相关的新 push、merge 或 PR head 变化时，才按新事实重新核验；附件挂载、scratch 路径或本地目录问题不得触发整套仓库重查。
- 普通本地或 GitHub 开发环境必须从最新远程 `main` 创建新分支。
- 仅当业务负责人在具体任务中明确要求改用 Codex 托管工作区时，才适用其平台注入的任务/PR 基线规则；不得自行切换到 Codex Cloud。
- 无论采用哪种环境，都不允许根据旧聊天中的 SHA、旧 PR 分支或人工猜测继续施工。
- 创建或更新 PR 后，必须由 GitHub Actions 对当前 PR head SHA、必需文件与目标分支再次校验；GitHub 上的 PR base/head 元数据是最终合并校验依据。
- 若平台提供的 base SHA 与当前任务/PR 元数据明确不一致，或 PR head SHA 与本次实际提交 SHA 不一致，立即停止，不得继续测试或要求合并。
- 预检所需文件不存在、仓库错误或已知 SHA 不一致时，立即停止并报告。

## 3. 修改模式

- 默认模式：增量功能注入（Incremental Injection）。
- 一个 PR 只解决一个明确目标。
- 不做与目标无关的重构、格式化、目录迁移或依赖升级。
- 若不改旧逻辑无法实现，先说明触碰位置、必要性、影响与回滚方法，取得批准后再修改。
- 新条件不满足时，原有行为必须保持不变。
- 禁止以“顺手优化”为由扩大范围。

## 4. 项目边界

当前系统：

- 独立部署、独立给员工使用；
- 细化“质检返工/尾部返工”业务；
- 暂不嵌入 ERP 页面或现有 ERP 节点；
- 数据模型、接口和事件必须保留未来接入 ERP “发起返工”等节点的能力。

不得直接复制 ERP 的巨型单文件实现。可以复用已验证的技术、部署、接口和治理经验，但新项目必须保持模块化边界。

## 5. 身份、人员与权限

- 禁止使用显示姓名作为数据库主键、权限判断或流程路由条件。
- 使用稳定的钉钉 userId/unionId 映射内部 userId，再映射角色和 capability。
- 必须先验证用户属于本公司钉钉组织，再执行系统准入与角色授权。
- 非本公司组织成员不得登录。
- 正式环境不得保留通行码登录。
- 钉钉工作台内支持免密登录；普通浏览器支持钉钉扫码登录。
- 前端可见性控制与后端授权校验必须同时存在。
- 所有关键操作记录操作者稳定 ID、角色、时间、动作、前后状态和业务对象。

特别注意：

- “李生”与“李总”指同一人。
- “李同生”是另一名不同人员。
- 不允许通过姓名相似性、称呼或人工猜测合并身份。

## 6. UI 与设计系统

- 业务可用性优先于视觉表现。
- 不得未经批准引入新的 UI 组件库或整体替换调色盘。
- 组件、颜色、间距、圆角、字体和阴影必须优先使用项目设计 token。
- Soft UI 只用于表面层级，不得降低文字、状态和操作按钮的对比度。
- 手机端表单正文默认保证清晰可读；不得为“信息密度”大量使用超小字号。
- 管理座舱中李总、伍云峰、张文豪使用同一套完整信息界面；李总与伍总同级同权，张文豪按执行职责获得操作能力，本厂承担最终审批仍由李总或伍总完成；所有操作通过审计日志追踪。
- 李同生使用中层工作台；基础员工只显示与其职责和待办有关的内容。
- 页面实现必须继承已验收返工模块的同类组件；新增布局按规则提供预览，同值参数对齐使用返工原页面作为基准。
- 任何 UI 工作先读取 `docs/requirements/rework-ui-golden-source-v1.0.md`。返工实际参数优先于共享 token 中的冲突值及旧文档；通过独立共享 UI PR 同步规则、token、组件与现有页面。不得为迁就旧 token 反改已验收返工，未来模块也不得另造参数。

## 7. 数据与集成原则

- 业务对象必须使用稳定 ID，并预留 `external_source`、`external_id`、`erp_node_id` 或等价映射能力。
- 任何未来 ERP 接入采用显式适配层，不得让返工业务直接依赖 ERP 页面内部状态。
- 关键状态变更应形成可追溯领域事件或 outbox 记录。
- 上传文件走服务端 OSS 能力；密钥不得进入前端、仓库、日志或 PR。
- ECS 环境变量、健康检查、备份和回滚方式参照 ERP 已验证做法。
- 不得未经批准读取、复制或重用 ERP 生产数据。

## 8. 测试与证据

每个 PR 至少提供：

- lint/静态检查；
- 构建结果；
- 与本次业务目标对应的自动化测试；
- 若涉及界面，提供桌面端与移动端截图；
- 若涉及权限，提供允许与拒绝两类测试；
- 若涉及状态流转，提供合法流转与非法流转测试；
- 当前 PR head SHA；
- 测试所对应的 commit SHA。

GitHub Actions 证据必须来自当前 PR head，不接受旧运行、其他分支或本地口头说明替代。

## 9. PR 交付格式

PR 描述必须包含：

1. 业务目标；
2. 本次范围；
3. 明确不在本次范围的事项；
4. 修改文件；
5. 测试证据；
6. base SHA 与 head SHA；
7. 已知风险；
8. 回滚方法；
9. 是否改变业务规则、权限、数据结构或 UI Golden Source。

## 10. 高风险红线

未经明确授权，不得：

- 修改钉钉应用配置、组织架构或生产权限；
- 修改 ECS 生产环境变量、密钥或安全组；
- 删除或覆盖生产数据、备份、OSS 对象；
- 合并 PR、部署生产或向外部人员发送通知；
- 将任何密钥、token、cookie、密码写入代码、日志或文档；
- 将未验收的 Figma 试验自动回写 ERP；
- 把尚未确认的业务选择伪装成确定规则。

发现冲突、权限不足、数据含义不清或 Golden Source 不一致时，停止施工并提交证据，不得猜测。

## 11. GitHub Actions Usage Constitution（P0）

详细制度见 `docs/governance/github-actions-usage-policy-v1.0.md`。以下规则高于施工便利性，适用于 ChatGPT、Codex、开发人员和其他 Agent：

- GitHub Remote 是阶段验收层，不是开发 scratchpad；能在本地/Codex 工作区完成的诊断、定向测试和集中修复不得通过连续 push 调试。
- 普通 PR Head 更新只能自动分配 `.github/workflows/ci.yml` 的单个 Quick Gate hosted job；禁止恢复第二个自动 Governance runner 或自动 Preview runner。
- Quick Gate 禁止 PostgreSQL、全量测试、migration replay、backup/restore、PR-17 acceptance、release packaging、Playwright/browser install 和 Preview。
- 重型验证只允许在 PR 带 `full-gate` label 时由 `.github/workflows/full-gate.yml` 执行；label 存在后的任何新 Head 都必须重新 Full Gate。
- 禁止 noop commit 仅为触发 CI；同一 Head 的失败 Job 最多 rerun 一次，再失败必须先查根因。
- Codex Review 只能在最终 intended Head 的 Full Gate 全绿后，由业务负责人手动触发；ChatGPT、Codex 或其他 Agent 不得自行触发。默认每 PR 一次；第二次仅限明确 P0/P1 或业务负责人授权。
- Full Gate 默认每 PR 最多两次；第三次需要业务负责人明确授权并说明前两次为何未收口。
- 正常开发 GitHub-hosted Linux minutes 月度目标不超过 1200，至少保留 800 included minutes 作为非计划储备。
- `scripts/ci/verify-actions-policy.mjs` 是机器红线。未经业务负责人在具体 PR 中明确授权，不得删除、绕过或弱化该脚本及本节规则。


## 12. 网页版 ChatGPT Work 固定施工流程（P0）

详细流程见 `docs/governance/chatgpt-codex-construction-workflow-v1.0.md`；当前路线与规则入口见 `docs/roadmap/platform-2.0-rules-index-v1.0.md`。任何新 Work 窗口或直接施工开始前必须先读取本文件、施工流程和平台 2.0 索引，再按索引读取本次任务唯一对应的业务规则。旧 `docs/roadmap/platform-sourcing-roadmap-v1.0.md` 只作为截至 2026-08-31 的历史施工记录。

涉及样衣模块的任何讨论、设计、编码、测试、PR 或迁移操作，必须在范围预检前完整读取 `docs/requirements/sample-system-migration-v1.0.md`。未读取不得开工；发现聊天内容、旧系统实现或旧文档与该规则冲突时，以该规则为准并报告冲突。身份、权限、数据源、金额口径、状态闭环或上线门槛的变更，必须先更新该规则并获得业务负责人明确批准。

涉及外发定价、多款价格、供应商中心、合同 PDF、正式派单、生产数据填报、实时生产看板或实时生产待办的任何任务，必须在范围预检前完整读取 `docs/requirements/sourcing-supplier-production-v1.0.md`。ERP 只可作为产品交互原型，不得读取、迁移、同步或引用 ERP 业务数据。样衣规则与外发供应商规则不得互相推导业务含义，也不得夹在同一个业务 PR 中。

以下规则为默认强制流程：

- 网页版 ChatGPT Work 同时承担施工控制器与执行器：读取 Golden Source、冻结范围、直接实施、审查 diff、管理 GitHub 交付并向用户汇报。
- 不得默认调用、切换或等待 Codex Cloud。只有业务负责人在具体任务中明确要求时，才可改变施工入口。
- “Codex Review”仅指最终 intended Head 的独立代码审查，不是施工执行渠道；其触发权仍只属于业务负责人。
- Work 发现当前目录是无 `.git` 的 scratch 时，必须按网页版 Work 规则立即使用 GitHub 远程事实继续，不得寻找旧工作树、反复初始化或把正常形态误报为阻塞。
- 完成修改和可用门禁后直接创建普通 PR（`draft: false`）；未经业务负责人明确要求，不得创建或转换为 Draft。
- PR 创建前必须判定门禁等级。数据库迁移/约束、权限身份、财务金额数量合同、核心状态机/审批/审计/幂等、跨模块关键链路、部署基础设施、共享平台壳或 P0/P1 变更，必须在 PR 创建后立即添加 `full-gate` label；不得等业务负责人提醒。
- PR 创建成功后必须立即报告 PR 链接、范围、测试结果、是否需要 Full Gate、是否需要 Codex Review并结束本轮；不得为了等待 CI、润色描述、整理计划或其他非阻断性收尾继续占用施工窗口。
- CI 作为异步状态处理；CI 后续失败时读取精确日志、做根因对应的最小修复，不得原地盲等或盲目 rerun。`skipped`、`cancelled` 和旧 Head 的成功不算通过。
- Codex Review 只能在最终 intended Head 的所需门禁全绿且 diff 冻结后进行。高风险 PR 必须请求，低风险纯文档/文案/CSS/隔离测试维护默认可不请求。
- Codex Review 只能由业务负责人手动触发。ChatGPT、Codex 和其他 Agent 不得自行触发、代点或暗中触发；需要 Review 时必须明确请业务负责人触发。
- 当前 Head 的所有适用门禁和必要 Review 完成后，必须立即明确回答“可以合并”或“不能合并 + 唯一具体阻塞”，不得只汇报绿色状态让业务负责人自行判断。
- PR 合并和部署只能由业务负责人明确决定。业务负责人报告已合并后，必须核验远端 merged 状态与最新 `main` SHA，再给出路线中的下一步。
- 完整门禁分类、Review 条件和全绿后交接步骤以 `docs/governance/chatgpt-codex-construction-workflow-v1.0.md` 第 6–8 节为准。
- 用户说“停”后立即停止一切检查、写入、PR 操作和等待。
- 业务负责人的明确授权可以覆盖本节的流程性默认规则；临时授权仅限所述范围和当前任务，长期例外必须通过版本化文件和 PR 固化。任何授权均不得绕过平台安全策略、密钥和生产数据保护或法律合规要求。

