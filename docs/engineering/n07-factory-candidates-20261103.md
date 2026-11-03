# B：N07 / N09 责任供应商候选与加载竞态

## 本轮接续的准确边界

本轮从现有 PR #897 的固定 head `a5938db04e635186acaa3f8a999ed917f56b6556` 取得源码并补增量，目标分支仍为 `release/digital-production-v1`。原 Pro 的未推送工作区、悬空 commit 和原附件不可取得；没有声称恢复这些内容。保留该 head 已有的后端候选过滤、N07 候选状态及 PG 反例，只修独立审查发现的主加载竞态和 N09 候选错误状态。

- **N07 主加载**：每次加载使用单调代次和独立 AbortController。详情、身份及异步权限解析完成后分别复核当前代次；A→B→A、迟到错误、旧权限回包及卸载后的结果均不能写回当前页面。候选重试只刷新候选，保留原普通及批量判责草稿。
- **N09 候选**：沿用原订单范围 API 及能力判断，通过共享 helper 显式解析原裸数组响应。候选独立区分 loading / ready / forbidden / error；401/403、网络、HTTP 或格式错误不再变成真正空目录。错误可手动重试，保留选择、原因及扣款草稿；只有成功且该责任类型确实无候选时才显示原受控新增入口。原台账本身 403 时的隐藏行为保持不变。
- **历史与权限**：不改供应商主档、角色、后端权限、已有候选筛选、返工数量、金额计算、工资或历史记录，不推断用户指定现场缺陷的根因。
- **真实组件验证**：新增 `tests/unit/responsibility-panels-component.test.ts`，用 React 19.2.4 的 `createRoot` / `act` 挂载真实 N07/N09 组件和原控件，控制合成网络回包与权限回包的时间。不是以源码字符串断言替代组件行为；所有请求均为隔离夹具，没有现场请求或业务写入。
- **依赖边界**：仅精确新增 `jsdom@30.1.3` devDependency；其 Node engine 支持本轮的 Node 22.22.2。比对原 lock 的全部既有非根条目，均未改变；仅增加该依赖及其必需依赖树。测试以文件级 jsdom 环境进入原 `tests/**/*.test.ts` 规范集合，没有新增测试框架、UI 库或 Vitest 配置。

## 本轮实际验证记录

环境为隔离 Node 22.22.2 / npm 10.9.9，Vitest 4.1.10。以下只代表本轮本地源码检查，不代表最终提交的正式 Review 或 Full Gate。原命令、UTC 时间、退出码、完整 stdout/stderr、日志 SHA256 及 Vitest JSON 保存在仓库外 `verification-b/`；首次失败记录保留。

| 检查 | 实际结果 | 记录 |
| --- | --- | --- |
| 四个内部包 `build:packages` | exit 0 | `build-packages.record.json` / `.log` |
| 真实 N07/N09 组件 | 23 pass / 0 fail / 0 skip，exit 0 | `component-tests-first.json` / `.record.json` / `.log` |
| 定点补充身份迟到与台账刷新两个组件用例，仅 `-t` 过滤这两项 | 2 pass / 0 fail / 23 filtered（Vitest 原 JSON 记为 skipped），exit 0；该测试文件 ESLint 通过 | `component-additional-tests.json` / `.record.json` / `.log`；`component-additional-eslint.record.json` / `.log` |
| Web 原生 typecheck | exit 0 | `web-typecheck.record.json` / `.log` |
| 3 个变更源码及新组件测试的 ESLint | 0 warning，exit 0 | `targeted-eslint.record.json` / `.log` |
| 既有候选、N07/N09、金额、舍入、幂等、应用服务及两份 HTTP 路由回归，17 文件 | 首轮 79 pass / 1 fail / 0 skip，exit 1 | `existing-responsibility-regressions.json` / `.record.json` / `.log` |
| 仅修正上述旧 UI 契约后重跑该文件 | 2 pass / 0 fail / 0 skip，exit 0；该测试文件 ESLint 通过 | `existing-ui-contract-fixed.json` / `.record.json` / `.log`；`existing-ui-contract-eslint.record.json` / `.log` |

唯一既有回归失败来自 `external-responsibility-ui-contract.test.ts` 强制源码包含 `if (response.status === 403) return [] as Supplier[];`，这正是本轮要求移除的错误语义。该测试保留订单范围候选、新增入口及业务日期约束，改为确认使用共享候选加载器并禁止上述吞 403 写法；真实挂载组件另直接验证 401/403 不显示空目录或新增入口。其余 16 文件 78 个用例已通过，相关源码输入未再改变，因此复用原通过记录，没有重跑全组。不能把首轮 17 文件命令写成一次全绿。

组件用例覆盖 N07 的 A→B→A 迟到主响应与错误、权限 await 后失效、主请求/权限等待/候选期间卸载、普通和批量草稿重试，以及当前主加载失败；N09 覆盖 loading、401/403、HTTP/网络/对象形态/无效 JSON 失败、真实空数组、候选重试保留选择/原因/扣款草稿、A→B→A 旧候选、旧主加载错误、主请求与候选期间卸载、只读/无分配能力和台账 403。

定点复核另补两个真实用例，没有改变生产代码：N07 详情先返回、并行身份读取迟到，经历 A→B→A 后仍保留当前工序、草稿及候选请求次数；用合法 `handlerUserId=null` 响应和完全隔离的草稿 payload 捕获验证仍使用当前身份，该 mock 立即返回 409，不调用任何服务或写业务数据。N09 台账初次 503 后点击原“刷新”，恢复台账即重新读取候选，候选回包前显示 loading 且无空目录新增入口，回包后能够选择供应商。

这两个新增用例运行前后实际执行仓库 `scripts/ci/construction-evidence.mjs fingerprint`，分别采样于 2026-11-03 14:44:34.861–14:44:35.004 UTC 和 14:44:46.432–14:44:46.575 UTC，均为 `22cfa5abc0c7ab431d28bc3b7357f3322a49cb709ed763d45c99c39ebac9651f`。命令记录为 `component-additional-fingerprint-before` / `component-additional-fingerprint-after`。原 23 项源码另逐字保存在 `component-tests-first.source.ts`，原 JSON 和日志不变；不能把本次仅运行 2 项、过滤 23 项的原始 JSON 改述为单轮 25 项全绿。

本轮未执行 PG suite 或浏览器交互，也未访问现场或生产。官方 Playwright Chromium 安装入口下载后解压失败，已停止排障；上述组件检查是 jsdom 中的真实 React 挂载测试，不能称为浏览器测试。PG、最终风险映射及其必要检查由协调方针对冻结后的精确 head 按仓库规则执行，不能引用下方旧 head 的 21-suite 计划代替本轮映射。没有更新 Acceptance，没有自主 approve、部署或合并。

## 原 head 留存说明

以下内容来自 `a5938db04e635186acaa3f8a999ed917f56b6556` 的既有工程说明，保留其业务依据、检查失败与边界，**并非本轮新运行的记录**。其中旧交接包路径、64 项测试、环境限制、21-suite 计划和当时分工均按旧记录理解；本轮只认上方明确列出的实际检查，最终 head / gate 证据由协调方统一记录。

## 独立基线与现场证据边界

- 基线：`c2c49369898b7f9943fb280342a56d9a98b0b30b`，不依赖 A 的代码、迁移或新字段。
- 来源：2026-11-03 用户在本 Pro Chat 的 B 授权及独立补丁交接要求。
- 用户提供母单 `083e2f04-eb55-4509-8728-45470adb4034`、返工 `45fb571a-9512-4af6-b268-ff803b9d5f7e`、正确厂代码 `TEST-UAT-1006-FACTORY2`。
- 本窗口没有取得该厂实际 supplier ID/type/active，也没有该次现场 HTTP 请求、状态码、响应体或服务日志。没有连接生产或 Acceptance 去补证。因此不能断言该现场问题就是 active `other` 引发；也不能断言正确厂停用、类型错误或处理人无权。
- 本次只修下述能由源码及隔离测试验证的问题，不改主档、角色、处理人、补缝 2、整查 10、工资 9 或收货装箱记录。上述现场历史数值来自用户，未在本窗口数据库核验。

## 可证缺陷

1. `0005_access_master_data.sql` 允许供应商类型 `factory / embroidery_washing / fabric / other`。
2. `ResponsibilityDeterminationApplicationService.listSupplierOptions` 原查询只有 `active=true`，会把 active `other` 一起返回；TS 的三值注解不会过滤真实 SQL 行。
3. `responsibility-determination-routes.ts` 用 `ResponsibilitySupplierOptionsResponseSchema` 解析响应，该契约只接受前三类。因此**若目录存在 active other 且请求已获准**，响应解析会失败。这是条件性代码缺陷，与指定现场请求是否满足条件是两回事。
4. 页面 `requestSuppliers(...).catch(() => setSuppliers([]))` 原把 HTTP/网络/schema 失败统一当成空候选，用户看到“没有可用供应商”，无法区分失败、权限和真空。

## 最小修复与保护

- SQL 增加三类责任供应商的明确过滤，保留 `active=true`、原排序、返工单状态、`responsibility_can_determine`、现有能力和 Root 语义；不扩大 response schema 让 `other` 可承担工厂责任。
- 读取 helper 返回 loading / ready / forbidden / error 状态。只有成功且通过契约的空数组才是“没有可用”。401/403 显示无权，其他 HTTP/网络/格式失败显示加载失败；错误可手动重试，不自动反复请求。
- 普通和批量判责的原 SearchSelect 使用相同状态，加载/失败/无权时禁用。使用原页面组件/样式，不新增业务豁免或新页面。
- 新请求中止旧请求，订单变更或组件卸载后忽略旧结果；发生错误不会把旧请求结果写入另一张单。候选成功加载后仍按原逻辑核对默认加工厂，不改保存/定稿/工资/收货逻辑。

## 影响记录

| 批准规则 | 写入入口/变更 | 读取与旧消费者 | 初始化与历史边界 | 验证 |
| --- | --- | --- | --- | --- |
| 候选符合既有责任类型 | application-service 的只读 SQL | N07 supplier-options HTTP schema、单项/批量选择 | 无迁移、无主档改写、原权限不变 | 应用权限单测、真实 HTTP 路由注入；full-business-chain 内 PG 反例待跑 |
| 不把失败当真空 | responsibility-supplier-options helper、原 panel | 普通/批量 SearchSelect 与错误提示 | 无新存储；不修改既有保存/定稿/幂等键 | 网络、401/403、404/500/503、格式错误、空/非空与 loading 单测 |
| 保留业务历史 | 无业务写入变更 | 原 N07/N08/N11、责任金额、舍入与工资链 | 用户指定现场数据未触碰 | 原责任金额/舍入/提交/幂等测试；PG 同事务反例核订单/工资不变，待跑 |

## 固定检查与实际结果（旧 head 历史）

Node 22.22.2 / npm 10.9.9；使用仓库原脚本和依赖，不安装新测试框架。原始命令、退出码、时间、来源指纹和日志在交接包 `verification/`。

- 四个内部包构建：通过；API 构建：通过。两项在最后的 Web-only 修正前捕获了输入路径和指纹，之后核对未变化，复用成功结果。
- 全 workspace 类型检查首轮：**失败，exit 2**。唯一报告错误是新 helper 将 `AbortSignal | undefined` 显式传给开启 exactOptionalPropertyTypes 的 RequestInit.signal；其它 workspace 未报告类型错误。
- 修复为 `signal: signal ?? null` 后：Web 原生 typecheck 通过；Web 构建通过；全部 7 个实际修改 TS/TSX 文件的仓库 ESLint 通过；10 个固定定向测试文件 **64 pass / 0 fail / 0 skip**；worktree secret scan 通过。
- 首轮失败日志保留，不把第一次全 workspace 命令标为成功。没有为这一处 Web 修正重跑 API/内部包构建或无关全量测试。

## PG 反例及剩余验收

在原 `full-business-chain-postgres.test.ts` 的 N07 链路内补充真实 PG 反例，不改 suite/case 的原超时：以原处理人读取候选，同一事务临时建立 active `other` 与 inactive factory；原 active factory/fabric 必须仍被返回且整个响应可通过既有 schema，两个反例必须排除，QC/不存在订单继续被拒。finally 回滚两条主档夹具，随后核订单和工资原记录不变，继续原责任分摊/定稿/后继断言。

该 PG 反例及完整数据库组 **未运行**。PG16 二进制存在，但本环境低权限执行被拒；没有运行 root PG、提权、换等效路径或连接其它数据库来规避。协调方须用仓库 canonical runner 的完整映射数据库组及原最终 Gate 补验，保持原预算、cleanup、断言和结果校验。迁移执行/PG13 等是否需要以实际风险图及最终组合为准，不擅自缩减门禁。

浏览器交互/现场请求验证未执行；本地通过的是加载模型、真实 Fastify 路由注入（服务隔离）、类型、构建和原 UI 接线测试。当前补丁不证明指定正确厂已在现场恢复可选。协调方如取得原始只读 HTTP/主档证据，应先判明请求失败、无权或真实空集；不得为了该现场单擅改供应商主档、放宽角色或重算历史数据。

## 原 A+B 的 Full 复用与映射核对（旧 head 历史）

按实际 base→candidate 路径调用仓库 `classifyFullGatePaths` 和 `fullGatePostgresPlan`，`tests/integration/full-business-chain-postgres.test.ts` 已被 mapped 与 chain 同时选中，Set 去重后只执行一次，配置为 `vitest.postgres-immediate.config.ts`。当前计划共 21 个 PG suite；完整风险标志、文件集合和配置见交接包 `verification/b-canonical-plan.json`。无需修改映射或 CI。

用户最新授权仅限本轮 A+B：由各自精确 Head 的原 GitHub Full Gate 执行隔离 PG16 与规定权限的 canonical 组，核实际日志/用例/通过失败跳过数、执行回执和 cleanup；相同输入与环境已有有效 Full 结果时，不再先后重复本地同组 PG。保留风险图要求的其他阶段，不把 A 的 Full 结果用于 B，不跳过必需门禁，不改变 30 分钟上限、测试超时或断言。此安排不写入 AGENTS.md。

本窗口已核官方 GitHub 连接器具有 tree/commit/new branch/PR 操作，本地原 gate controller CLI 所需 gh 未认证。用户已明确将两者分工：本 Chat 在完整 tree/parent/branch 回读一致后报告独立提交与草稿 PR；Work 只对同一精确 Head 使用原控制器请求 gate，无需重新传补丁或本地重复同组 PG。没有认证传输改造，不直接建 ci-final 引用，不自主 approve PR。实际远端提交 SHA、PR 与回执在提交外记录，不能用权限元数据声称已推送。若正式写入被拒，则停在真实结果并交完整附件；此安排仅适用于本轮 A+B。
