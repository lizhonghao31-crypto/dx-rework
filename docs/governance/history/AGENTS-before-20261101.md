# 历史记录，不是当前执行指令

原分支 release/digital-production-v1，版本 3fd11867aa24a2433faf4a5d2409bbbe8325bd97。现行规则见根 AGENTS.md。以下原文保留取证。

# AGENTS.md

状态：长期施工规则 V2.1（2026-10-27 Review-first 更新）
适用仓库：`lizhonghao31-crypto/dx-rework`  
生效日期：2026-09-10（Acceptance规则补充：2026-09-30）

本文件只保留长期有效的施工纪律。阶段性 PR 计划、临时授权、已完成迁移步骤不得继续作为默认施工入口。

## 1. Golden Source 与优先级

1. GitHub `main` 是当前代码事实的唯一 Golden Source。
2. 当前业务负责人对本次任务作出的明确决定，可以更新既有业务规则；助手必须把已批准的新规则与实现同步写入对应文档，不得要求用户为同一决定重复确认。
3. 未被新决定覆盖时，业务规则按对应领域 Golden Source 执行：
   - 通用/返工：`docs/requirements/startup-requirements-v1.2.md`
   - 平台权限：`docs/requirements/platform-permission-golden-source-v1.0.md`
   - 样衣：`docs/requirements/sample-system-migration-v1.0.md`
   - 外发定价、供应商、合同、生产：`docs/requirements/sourcing-supplier-production-v1.0.md`
   - UI：`docs/requirements/rework-ui-golden-source-v1.0.md`
   - 业务分析与限定区域 UI：`docs/requirements/business-analysis-limited-ui-golden-source-v1.0.md`
4. 样衣迁移、供应商/外发建设、权限治理均已完成。上述文档中的业务标准继续有效，但历史迁移步骤、旧 PR 顺序、旧 SHA、旧“下一步”和临时授权仅作历史，不得自动恢复施工。
5. 截图、旧聊天、旧 PR 描述和历史路线不能单独覆盖最新业务决定或当前 `main`。

## 2. 默认施工角色

- 默认由当前 ChatGPT Work/助手同时负责：需求分析、方案、代码修改、测试、PR 修复和交付。
- Codex 默认只做独立 Review，不承担编码施工。
- 只有业务负责人对当前任务明确要求“使用 Codex 施工/编码”时，才允许委派 Codex 编码；“开始”“继续”“全程接手”“所有授权”等不等于授权 Codex 施工。
- Review finding 由当前助手核验并修复，不默认交回 Codex 编码。

## 3. 执行模式与授权

每个任务只需确定一次执行模式：

- **逐 PR 验收**：当前 PR 达到交付状态后等待业务负责人确认，再进入下一 PR。
- **全程接手**：在业务负责人明确授权的范围内，连续完成施工、门禁、必要 Review、修复及获授权的合并，不因普通可处理阻断自行停工。

临时授权只对明确范围和当前任务有效；任务结束后恢复默认。用户说“停”时立即停止一切写入、检查、等待和后续推进。

## 4. 一次预检，避免重复核验

开始修改前只做一次必要预检，记录：

```text
repository: lizhonghao31-crypto/dx-rework
base branch: <explicit authorized target; default main>
base SHA: <actual remote target tip; not a stale PR base snapshot>
working branch: <branch>
task scope: <one sentence>
allowed files: <paths>
forbidden files: <paths>
gate class: QUICK or FULL
```

没有新的 push、merge、PR Head 变化或真实错误时，不重复读取同一 PR、同一仓库状态或同一规则全文。查询 CI 就读取当前运行与必要日志；查询 Review 就读取新增 finding；查询能否合并就直接给出“可以/不可以 + 唯一阻塞”。

## 5. 修改模式与 PR 范围

- 默认使用 Incremental Injection。
- 一个 PR 解决一个可独立验收的业务目标，不按文件数或代码行机械切碎。
- 实现该目标所必需的代码、测试、migration、manifest、文档应一次完整处理。
- 不做无关重构、格式化、依赖升级或“顺手优化”。
- 开工时确定完成标准；达到标准后收口，不临时增加可选基础设施、重构或测试平台作为前置条件。

## 6. Push / CI 纪律（P0）

GitHub Actions 是验收层，不是开发 scratchpad。

- 先读取真实错误/Review，定位根因，集中完成相关修改和定向检查，再 push。
- **已知没改完不得 push。**
- 多文件修改必须先完整组装、检查，再形成一个 intended Head；不得每改一个文件就 push 一次。
- Gate 运行期间保持 Head 稳定。只有发现真实阻断且已完成集中修复后，才产生下一次 Head。
- 不允许用“push 看看 CI 怎么说”的方式调试。
- 同一 Head 的瞬态失败最多 rerun 一次；再次失败先查根因。
- 禁止 noop commit 只为触发 CI。

- 开工记录旧测试健康、入口/读取消费者清单，以及合法/非法、失败/回滚、重试/并发矩阵；已知范围内遗漏须集中收齐再推送。
- 执行顺序：**本地验证 → push 轻检查与必要 GitHub Codex Review → 收齐发现集中修复 → 冻结最终 SHA → 显式跑对应 Gate → 核准合并**。不得为尚在审查的每个小修复反复启动昂贵 Gate。
- 轻检查、最终 Gate、Review、合并、部署和业务验收分别报告；每个实际阶段给命令/结果/阻断，活动中不得超过一分钟没有有意义的进度说明。
- 已授权范围连续推进，不重复询问同一普通步骤；拒绝动作须报告原动作/原因/是否执行，不换路径绕过。授权变化要保存原始用户证据。

详细 Actions 规则见 `docs/governance/github-actions-usage-policy-v1.0.md`。

## 7. Quick Gate / Full Gate 二选一（P0）

在创建 PR **之前**确定 Gate 等级，并体现在 PR 标题：

- `[QUICK] ...`：低风险，push 先跑轻检查；最终显式请求 Quick Gate。
- `[FULL] ...`：高风险，push 先跑轻检查；最终只选择 Full 重检查，不额外跑完整 Quick。轻检查不代表最终 Gate。

下列任一项使用 `[FULL]`：

- migration / schema / 数据回填 / 数据库约束；
- 登录、身份、角色、capability、字段权限、Root/老板特权；
- 金额、单价、数量、工资、合同、付款、结算；
- 核心状态机、审批、审计、并发、幂等；
- 跨模块关键链路、通知/待办关键路由；
- 部署、发布、备份恢复、GitHub Actions / 基础设施；
- 共享平台壳或影响多个模块的公共能力；
- P0/P1 修复；
- 业务负责人明确要求 Full Gate。

纯文档、低风险文案/CSS、隔离测试维护等，在不触及上述边界时用 `[QUICK]`。

任何新 Head、真实 base tip 或等级变化都使旧最终批准不适用。合并证据必须来自当前完整 Head 的实际成功 job 和对应 base/等级；同名 skipped、旧 SHA、缺失/空跑不得放行。受支持工具见 `docs/governance/review-first-final-head-20261027.md`；仓库保护设置未配置时不得声称此为服务器硬门禁。

## 8. Codex Review

- 业务负责人长期要求（2026-10-03）：凡需要 Review 的 PR，统一在 GitHub PR 上使用 **Codex Review**；本地、子代理或其它独立审查不能替代。此规则不表示所有 PR 都必须 Review，是否需要仍按下述风险与授权判断。
- 本地完整自查、push 轻检查实际通过后发起 GitHub Codex Review；审查发现与同范围自查遗漏一起修复，再冻结最终 Head 跑相应 Gate。记录实际审核 SHA、修复后的最终 SHA 及 finding 闭环，不冒称最终提交再次审核。
- 是否需要 Review按当前任务风险和业务负责人授权执行；权限、财务、migration、核心状态机、P0/P1 默认应 Review。
- 正常结论默认每 PR 一次。用户长期授权（2026-10-27）：从请求发出起 **15 分钟无结论一律异常**，先核刚完成/新请求，再重开一轮；不 push、不重跑 CI、不将超时/服务失败算通过。每轮重新计时，不并发多发；发送结果不确定或被拒先核结果，不盲重试。
- Review 建议先核验是否真实、未过期且属于本 PR；范围外重构和纯偏好不自动阻塞交付。
- Codex Review 不得自动转化为 Codex 施工。

## 9. 测试与结论纪律

收尾记录精确 merge SHA/tree、已跑/失败/未跑边界、实际检查与审查耗时/次数，以及重复检查或返工原因；无日志不得猜工时或模型速度。

“已修改”“定向测试通过”“Gate 通过”“Review 通过”“已合并”“已部署”“业务验收通过”是不同状态，不得互相替代。

- 权限修改必须同时覆盖允许与拒绝。
- 状态流转必须覆盖合法与非法路径。
- UI 的 CI 全绿不等于视觉验收。
- 矩阵全绿不等于所有浏览器业务场景都执行过。
- 没有证据时不得给出超过证据范围的确定结论。

## 10. ECS / 生产操作

- 生产、Acceptance、备份、密钥和数据库操作必须先区分目标环境。
- 多步骤、包含 `set -e` / `exit` / `kill` / `mv` / migration 的维护命令，不直接粘贴进当前登录 Shell 执行；写成独立脚本后用 `bash <script>` 或后台方式运行，且不得 `source`。
- Acceptance 更新按实际 diff 选择最小动作；没有前端/依赖变化时不得默认 `npm ci`、全量 build 或在 ECS 上重跑 Gate。
- 低配置 ECS 上不得把 CI/Full Gate 当部署步骤执行。
- 任何轻量更新都必须保持运行代码、数据库 schema 与版本标识一致，不能只改显示版本号。
- **Acceptance Lab 唯一操作手册：`docs/operations/acceptance-lab-runbook-v1.0.md`。**进入A1/A2/A3/A4验收前必须先读该文件；不得重新发明Runner/SSH/tar传输链路、不得重复ENV初始化、不得把控制码错误当成部署错误。
- A1首次canonical切换完成后，后续批次只走“候选准备 → Acceptance数据库一次必要备份（仅存在migration时）→ 本机候选部署 → 公网技术验证 → Acceptance Lab业务验收”；**不再重复Nginx首次切换、旧root 3202清理、HBA/用户/目录初始化。**
- 当前Acceptance固定边界：生产活动API由已安装main双槽工具的稳定、可信 `active.json` 标识（`127.0.0.1:3201` 或 `127.0.0.1:3203`），Acceptance操作不修改生产槽或路由；Acceptance API `127.0.0.1:3202`；独立DB `dx_rework_acceptance`；运行用户 `dxacceptance`；canonical root `/opt/dx-rework-acceptance`；公网入口 `https://staging-api.dxerp.org.cn/acceptance`。
- Acceptance控制码是**5分钟、一次性**凭证；复制不完整、过期或已使用只需重新生成控制码，**不得因此重启API、重跑migration或重做部署**；凭证不得粘贴进聊天、PR、Issue、日志或文档。

## 11. 高风险红线

未经当前任务明确授权，不得：

- 修改钉钉应用配置、组织架构、生产权限、安全组或密钥；
- 删除/覆盖生产数据、备份或 OSS 对象；
- 使用 ERP 生产数据；
- 将 secret/token/cookie/password 写入代码、日志或文档；
- 修改业务 Golden Source 以迎合测试结果；
- 把未确认的业务选择伪装成确定规则。

Root 作为业务负责人/超级调试身份的既有特殊能力必须保留；不得为了普通角色约束顺手限制 Root。

## 12. 新窗口启动

新窗口只需读取：

1. 本文件；
2. `docs/governance/chatgpt-codex-construction-workflow-v1.0.md`；
3. 本次任务对应的唯一业务 Golden Source；
4. GitHub 当前 `main`、相关开放 PR 与 Head。

不得要求业务负责人重新叙述已经版本化确认的历史。

## 13. 工程效率与兼容意图（2026-11-01 授权治理）

- 本地与 CI 先运行 `npm run test:preflight`（原生 Node 协议、全仓时间索引、资源接线、迁移静态校验），不能用 Vitest 通过替代原生协议通过。
- 非 DB Vitest 在发现阶段排除数据库套件；PG 使用 `npm run test:postgres` 的 canonical plan、实际标记库/低权限角色、清空通用 DATABASE_URL 和相同配置。`npm run test:plan` 用于核对实际文件集合；长正确性用例使用明确有限配置，性能断言保持原约束。
- 同 Head/base/run/attempt、PG 实际版本、角色、库身份及配置下，mapped/整链/Root 审计并集一次执行，后续步骤核实际逐文件回执及成功清理。不同版本、角色、运行或配置不得复用。失败、全 skip、缺失文件或未清理不算通过。
- `ownedPostgresSchema`、manifest 与清理共用 `scripts/test-resource-contract.mjs` 注册定义；新/修改的 schema 创建入口必须使用 `createOwnedPostgresSchema`；消费者的每个裸 CREATE 均拒绝，不因同文件另有受管创建而豁免，未登记前缀/未生成资源在 DDL 前拒绝。昂贵 PG 前执行真实失败子进程的创建→登记→精确清理→无残留冒烟。只清本 run、正确实际测试库身份、32hex 尾码的精确资源；失败清理保留 manifest，不扫描/通配删除。
- release 集成证明实际冻结 release base→candidate；独立 Acceptance 更新证明自身实际 DB→candidate。实时 main 新增差异列为发布待办/未验证，不要求业务 PR 为绿灯复制 SQL。
- 生产晋级/切换仍须准确 main SHA 来源、实际 production ledger、声明支持历史的真实升级与必要应用语义验证。未知 identity/checksum 漂移/历史缺口硬拒。源级兼容、CI 通过均不能替代生产或应用验收；PMC 应用缺口保留独立上线待办。
- migration＋权限 inventory 保留真实升级、Root/ACL、低权限和恢复；维护/备份执行器、激活与打包传输分别映射，未知部署逻辑保守全测。本治理不改权限/财务/业务规则、branch protection 或部署授权。
