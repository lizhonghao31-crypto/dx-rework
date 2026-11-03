# A：尊重制单预缩选择，保留历史事实

## 范围与来源

- 基线：`c2c49369898b7f9943fb280342a56d9a98b0b30b`，`release/digital-production-v1`。
- 来源：2026-11-03 用户在本 Pro Chat 的 A 授权及补丁交接要求。用户指定旧母单 `c05e324b-53b9-4fc0-ba0f-65c27eb0a245` 的制单 v3、纸样黑色局部至全色、唛架及合并任务已完成。
- 原 A 增补聊天链接未能读取；没有把其未知内容当作已经审阅的规范。本补丁只依据本窗口明确文字及仓库源码，协调方仍须补充该增补全文并核对。
- 本轮用户最新授权由官方连接器按准确 base 原子提交到独立功能分支并创建草稿 PR；Work 读取同一精确 Head，使用仓库原控制器请求 gate。本窗口不手工造 gate ref、不自主 approve、不部署，不连接或修改生产、Acceptance、真实账号或订单。

## 已证实根因与实现

`BulkPreparationService.sync` 的新建字段原为 `g.parallel ? '需要预缩' : document.preshrink`，会覆盖 SLA 新路线制单明确的“无需预缩”。0256 的 `digital_bulk_workflow_version` CHECK 又要求 workflow 2 一定是“需要预缩”。两处共同使制单选择无法生效。

1. `bulk-preshrink-requirement.ts` 统一解析：存在 prep 时取其冻结选择；尚无 prep 时取已发布制单；缺失/非法值保持未知，不把未知解释为免做。新 draft 不替换已发布依据，后续发布也不倒写旧 prep。
2. 后继迁移 0272 只替换 workflow CHECK，保留 workflow 1 的批准快照要求、workflow 2 的 SLA 快照要求，以及原 preshrink 两值非空约束。无 UPDATE、批扫、触发器豁免或旧迁移修改。
3. sync 按实际要求创建任务/“无需预缩”事实，汇合仍等待验布、老板批准、纸样唛架及现有前置；task 创建和完成命令拒绝对无需预缩 prep 补造预缩任务/完成事实。
4. read、Journey（通过 bulk.read）、驾驶舱、系列计划取同一要求。系列计划预览依据增加 prep ID/要求，防止其变化后沿用旧预览。
5. SLA 只投影当前适用性：无需预缩时不计该节点，裁剪仍依赖验布和纸样；不改 P0、历史计划、任务起止、到期时间。已有真实预缩完成（包括时间未知）继续保留，不因投影隐藏。36 小时参数不变；新参数展示名由“必做预缩”改为“预缩”。

## 影响记录

| 规则 | 写入入口 | 实际读取与旧消费者 | 初始化/历史边界 | 验证 |
| --- | --- | --- | --- | --- |
| 明确选择冻结 | bulk.sync / 0272 / migration manifest | bulk.read、Journey、cutting gate | 新 prep 采用已发布值；旧 prep、v3、历史事实不回写 | 新解析单测；现有 P11 四路线；新增 PG 冻结/幂等反例（待跑） |
| 不生成免做实绩 | task.createWithClient / bulk.complete | task、todo、bulk workroom | 同原事务、订单锁、角色/订单权限和幂等，不增加公开豁免 | P11 none 断言无预缩任务/完成，拒绝补造；需要预缩正控保留（PG 待跑） |
| 计划不伪造实际 | bulkSlaEvidence / bulkEvaluationPlan | SlaOrderService、Journey、驾驶舱、SeriesPlanService | 当前投影不更新 P0/冻结标准；未知实绩仍未知 | 36h 差值、验布阻断、完成未知时间、原计划不变单测；原 SLA/系列计划测试 |
| 测试选择与实际动作一致 | bulk-preparation-fixture / business-anchor-fixture | sourcing / 原业务时钟套件 | none 夹具不再执行预缩；确实执行预缩的时钟夹具明确选择“需要预缩” | 保留旧权限、幂等、工资、实收与实裁断言；PG 全组由协调方补 |

## 指定旧单的纠正路径：仅设计，未实现、未执行

此补丁不会自动修正已被错误冻结为“需要预缩”的历史 prep。不能用发布 v4、重新派交、重建路线或回填完成时间来修正用户指定 v3。完整 A 增补未获前，不提供可执行历史修改脚本或普通业务豁免入口。

后续如单独批准维护实现，应满足以下条件：

1. **精确目标与结构化证据。** 请求绑定唯一母单 ID、已发布 instruction version=3、prep ID、source ID/round、原 SLA snapshot ID，以及原纸样/唛架 fact ID、task ID、work-range ID/line IDs 和各自版本。通过 FK/ID/版本关联；不从备注、款号或自由文本推导范围。原制单 document 的预缩字段必须明确为“无需预缩”。黑色局部至全色的范围链必须与原任务和 prep 对应，不能用另一轮次完成抵扣。
2. **预览与审计。** 只读预览列明上述全部预期值、将追加的纠正记录、待排除的未完成预缩任务和未改变的事实/时钟。执行需专门授权；记录原因、操作者、前后有效要求、精确证据引用及请求内容摘要。不得常驻普通办理按钮、按范围扫描或部署时自动执行。
3. **锁与并发。** 沿用现有任务生命周期事务锁及母单行锁，锁定精确 prep 和受影响 task，事务内重新核对预览的版本/摘要。制单变版、范围变动、任务已完成/转轮、真实预缩或实裁出现时拒绝旧请求，不能扩大范围继续执行。
4. **追加纠正，不覆盖历史。** 建议独立 append-only 纠正记录，通过结构化键关联原 v3/prep/facts/tasks。冻结 prep 原字段、v3 document、纸样/唛架事实、范围、P0 和 SLA 快照保留。只让统一有效要求解析器在显式已批准纠正记录存在时投影“无需预缩”。本次解析器尚不读取任何此类纠正记录。
5. **任务处理与幂等。** 如确有错误创建且未完成的预缩任务，维护方案须明确追加取消/不适用的审计事件并保留原任务及全部时钟/历史；不得把它记成完成、删除任务或重开已完成合并任务。相同请求键和 payload 重放返回原结果，不重复记录或通知；同键不同 payload、跨母单/轮次/fact/task 一律拒绝；失败整笔回滚。
6. **独立验收。** 精确 v3 正控、需要预缩反例、跨单/跨轮/错误 fact/task 反例、真实完成/实裁冲突、并发同键、事务中断、时钟和历史逐字段不变均须 PG 验证后，才能另行审批执行。此次不具备该维护实现或线上数据证据。

## 本地验证与未完成项

Node 22.22.2 / npm 10.9.9，复用已核锁文件依赖。当前检查和原日志摘要见同补丁的 `construction-evidence.json` 及交接包 `verification/`；测试入口和固定文件集合保存在交接包中。

已运行：四个内部包构建；相关 TS 真实 ESLint；仓库全工作区 typecheck；API 和 Web 构建；迁移静态 lint；9 个定向测试文件共 87 项（87 pass、0 fail、0 skip）；仓库 worktree secret scan。

尚未运行：PG16/PG13 迁移实际执行、受影响 PostgreSQL suites、新增 PG 反例及完整数据库 Gate。PG16 二进制可运行，但本环境只能映射 UID 0，已拒绝低权限切换；未运行 initdb/server，未改走提权或其它数据库。静态 lint 与单测不代替 PG 结果。

协调方应按实际风险映射和仓库 canonical runner 运行 sourcing-pr03、production-readiness、series-plan/SLA 及受共享夹具影响的业务时钟组，并核完整文件通过/失败/跳过。保持原超时和断言，不拼接旧 Head 的成功结果。当前 construction evidence 只记录已执行本地检查；pendingVerification 明列 PG 未跑。PG 尚无通过回执，不能声称最终验收完成或据此合并。

## 本轮 A+B 的 Full 复用与映射核对

按实际 base→candidate 路径调用仓库 `classifyFullGatePaths` 和 `fullGatePostgresPlan`，`tests/integration/sourcing-pr03-postgres.test.ts` 已被 mapped 与 chain 同时选中，Set 去重后只执行一次，配置为 `vitest.business-chain.config.ts`。当前计划共 27 个 PG suite；完整风险标志、文件集合和配置见交接包 `verification/a-canonical-plan.json`。无需修改映射或 CI。

用户最新授权仅限本轮 A+B：由各自精确 Head 的原 GitHub Full Gate 执行隔离 PG16 与规定权限的 canonical 组，核实际日志/用例/通过失败跳过数、执行回执和 cleanup；相同输入与环境已有有效 Full 结果时，不再先后重复本地同组 PG。保留风险图要求的其他阶段，不把 A 的 Full 结果用于 B，不跳过必需门禁，不改变 30 分钟上限、测试超时或断言。此安排不写入 AGENTS.md。

本窗口已核官方 GitHub 连接器具有 tree/commit/new branch/PR 操作，本地原 gate controller CLI 所需 gh 未认证。用户已明确将两者分工：本 Chat 在完整 tree/parent/branch 回读一致后报告独立提交与草稿 PR；Work 只对同一精确 Head 使用原控制器请求 gate，无需重新传补丁或本地重复同组 PG。没有认证传输改造，不直接建 ci-final 引用，不自主 approve PR。实际远端提交 SHA、PR 与回执在提交外记录，不能用权限元数据声称已推送。若正式写入被拒，则停在真实结果并交完整附件；此安排仅适用于本轮 A+B。
