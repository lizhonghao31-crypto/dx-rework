# B：N07 责任供应商候选与加载状态

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

## 固定检查与实际结果

Node 22.22.2 / npm 10.9.9；使用仓库原脚本和依赖，不安装新测试框架。原始命令、退出码、时间、来源指纹和日志在交接包 `verification/`。

- 四个内部包构建：通过；API 构建：通过。两项在最后的 Web-only 修正前捕获了输入路径和指纹，之后核对未变化，复用成功结果。
- 全 workspace 类型检查首轮：**失败，exit 2**。唯一报告错误是新 helper 将 `AbortSignal | undefined` 显式传给开启 exactOptionalPropertyTypes 的 RequestInit.signal；其它 workspace 未报告类型错误。
- 修复为 `signal: signal ?? null` 后：Web 原生 typecheck 通过；Web 构建通过；全部 7 个实际修改 TS/TSX 文件的仓库 ESLint 通过；10 个固定定向测试文件 **64 pass / 0 fail / 0 skip**；worktree secret scan 通过。
- 首轮失败日志保留，不把第一次全 workspace 命令标为成功。没有为这一处 Web 修正重跑 API/内部包构建或无关全量测试。

## PG 反例及剩余验收

在原 `full-business-chain-postgres.test.ts` 的 N07 链路内补充真实 PG 反例，不改 suite/case 的原超时：以原处理人读取候选，同一事务临时建立 active `other` 与 inactive factory；原 active factory/fabric 必须仍被返回且整个响应可通过既有 schema，两个反例必须排除，QC/不存在订单继续被拒。finally 回滚两条主档夹具，随后核订单和工资原记录不变，继续原责任分摊/定稿/后继断言。

该 PG 反例及完整数据库组 **未运行**。PG16 二进制存在，但本环境低权限执行被拒；没有运行 root PG、提权、换等效路径或连接其它数据库来规避。协调方须用仓库 canonical runner 的完整映射数据库组及原最终 Gate 补验，保持原预算、cleanup、断言和结果校验。迁移执行/PG13 等是否需要以实际风险图及最终组合为准，不擅自缩减门禁。

浏览器交互/现场请求验证未执行；本地通过的是加载模型、真实 Fastify 路由注入（服务隔离）、类型、构建和原 UI 接线测试。当前补丁不证明指定正确厂已在现场恢复可选。协调方如取得原始只读 HTTP/主档证据，应先判明请求失败、无权或真实空集；不得为了该现场单擅改供应商主档、放宽角色或重算历史数据。

## 本轮 A+B 的 Full 复用与映射核对

按实际 base→candidate 路径调用仓库 `classifyFullGatePaths` 和 `fullGatePostgresPlan`，`tests/integration/full-business-chain-postgres.test.ts` 已被 mapped 与 chain 同时选中，Set 去重后只执行一次，配置为 `vitest.postgres-immediate.config.ts`。当前计划共 21 个 PG suite；完整风险标志、文件集合和配置见交接包 `verification/b-canonical-plan.json`。无需修改映射或 CI。

用户最新授权仅限本轮 A+B：由各自精确 Head 的原 GitHub Full Gate 执行隔离 PG16 与规定权限的 canonical 组，核实际日志/用例/通过失败跳过数、执行回执和 cleanup；相同输入与环境已有有效 Full 结果时，不再先后重复本地同组 PG。保留风险图要求的其他阶段，不把 A 的 Full 结果用于 B，不跳过必需门禁，不改变 30 分钟上限、测试超时或断言。此安排不写入 AGENTS.md。

本窗口已核官方 GitHub 连接器具有 tree/commit/new branch/PR 操作，本地原 gate controller CLI 所需 gh 未认证。用户已明确将两者分工：本 Chat 在完整 tree/parent/branch 回读一致后报告独立提交与草稿 PR；Work 只对同一精确 Head 使用原控制器请求 gate，无需重新传补丁或本地重复同组 PG。没有认证传输改造，不直接建 ci-final 引用，不自主 approve PR。实际远端提交 SHA、PR 与回执在提交外记录，不能用权限元数据声称已推送。若正式写入被拒，则停在真实结果并交完整附件；此安排仅适用于本轮 A+B。
