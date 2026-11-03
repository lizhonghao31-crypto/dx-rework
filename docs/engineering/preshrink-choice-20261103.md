# A：原 v3 预缩要求的受限纠正与统一读取

## 本轮边界与真实来源

本轮从官方 GitHub 固定 head `36597942d20ec1ec81e709423b6ca7841ceb5d98` 的源码继续，只补未推内容，沿用 #896 及 `fix/preshrink-choice-20261103`。release 基线为 `c2c49369898b7f9943fb280342a56d9a98b0b30b`。没有取得原 Pro 的未推工作区、悬空提交或附件，也没有把本次快照称为原工作区恢复。

依据为用户 2026-11-03 的明确 A/B 授权、独立审查交接和本仓库适用 AGENTS.md。保留原 PR 已完成的新 prep 选择、0272、SLA 评价副本及既有正控调整。用户指定原母单 `c05e324b-53b9-4fc0-ba0f-65c27eb0a245`，原制单 v3、纸样黑色局部至全色、唛架及合并任务已经完成；这些业务事实仍须由受限事务在实际执行前逐项核对，本轮没有访问现场数据确认它们。

只修改代码、测试和记录；不新建分支或 PR，不部署、不操作生产或 Acceptance、不自行 approve。用户已授权 A、B 各自通过必要检查后分别合入 release；此次收口先冻结各自 head、交协调方/Work 核对，再由原控制器各申请一次必要 Full。Acceptance 仍待 A/B 都完成后统一安排。

## 保留的原修复

新建 prep 采用已发布制单明确的预缩选择，未知保持未知；新草稿不替换已发布依据。0272 只修正 workflow 2 的旧 CHECK，保留 SLA 快照及其它约束，不改 0256，不回写旧 prep、制单、任务或时钟。真正需要预缩的路线仍创建、办理并计入预缩。

SLA 通过当前评价副本判断适用性，保留 P0、冻结标准、原实绩及未知时刻。36 小时参数没有改变；裁剪仍等待原验布许可、批准和纸样唛架条件。

## 本轮新增的受限命令

原产前路由下新增 `preshrink-correction/preview` 与 `preshrink-correction/apply`；不增加普通业务按钮、批量入口、自动执行脚本或通用免预缩能力。

- 仅允许上述固定母单、当前已发布 v3、原 workflow 2 的错误“需要预缩”prep；制单必须明确“无需预缩”，客户确认及技术依据仍有效，来源/轮次/SLA 快照必须一致。
- 真实 Root 身份在事务锁内经 RootAuthority 核验有效账号、钉钉映射及在职状态；客户端角色字符串不构成授权。幂等回执读取前同样复核身份。
- 目标结构化绑定 prep、原 v3、source/round、SLA snapshot、原纸样任务、纸样/唛架 fact、原 work-range ID/kind/version 和指定错误预缩 task。连续范围链须已有局部记录和全色完成；不能用另一单、另一轮、另一任务抵扣。
- 沿用任务生命周期事务锁、母单行锁和精确任务锁；预览摘要包含制单指针、原业务事实/范围/PO、任务/事件/条件/依赖、时钟/期限、派工、准备窗口、物料及批准。apply 锁内重读，任何相关依据变化均拒绝旧预览。
- 已暂停/取消/特殊结案、真实预缩 task/fact/event/clock 完成、已有实际开裁，或存在其它未完成预缩任务时拒绝纠正。
- 单事务仅退役指定未完成预缩任务，追加“无需预缩”fact、取消事件和原 event intent、audit、纠正记录及范围关联、幂等回执。所有原 prep/v3/纸样唛架/范围、任务进入时刻、原时钟和期限保留；不伪造完成。
- 纠正后的汇合只处理同一原 prep，经共享的原质量和批准门禁决定是否生成裁床待办。该路径不初始化准备窗口、不新建 prep、不调用整单批量取消。
- 相同操作者、命令、key、payload 重放返回原回执；同 key 不同 payload 拒绝。任一阶段失败整笔回滚，不重复取消、事实、审计或通知意图。

0273 仅创建两张受限、只追加的关联表及验证触发器。固定订单/v3约束、FK、原事实归属、取消事件/intent/audit一致性和禁止 UPDATE/DELETE/TRUNCATE 均在数据库边界保留；没有自动修改旧历史。迁移 manifest 与后续迁移权限 inventory 同步列入 0272/0273。inventory 是源码元数据维护，不执行 Acceptance 更新。

## 统一有效要求与历史保留

`readBulkPreshrinkRequirement` 只接受精确 prep 的受限纠正记录；任意独立“无需预缩”fact、后来草稿或发布值均不能覆盖原冻结选择。旧 schema 尚无纠正表时保留旧读取语义。

| 消费者 | 本轮行为 |
| --- | --- |
| sync / bulk.read | 同源读取有效要求；保留原质量许可与批准 |
| bulk.complete / 旧 task.complete / task.create | 有效无需预缩时拒绝补造预缩任务或实绩 |
| SLA 当前评价、驾驶舱、系列计划 | 同源适用性；系列计划预览加入 correction ID，使旧预览失效 |
| Journey 明细与紧凑读取 | 只将未真实完成的纠正节点投影为不适用，保留实例、记录、时刻及历史 |
| task 详情与 Journey task summary | 同一精确退役 ID 从任务分母排除；不把其它取消任务一概排除 |

已完成的真实预缩仍保留，已完成合并任务不会重开。没有修改供应商、返工数量、工资、生产数据或任何旧迁移。

## 本轮真实检查与待验证项

Node 22.22.2 / npm 10.9.9。记录以当前 `construction-evidence.json`、本轮原始日志与 Vitest JSON 为准，旧 head 的 87 项结果不作为本轮完成凭证。

已完成且不重复：依赖安装、四内部包构建；较早的全工作区类型检查通过后，只因本轮复核修正了 API 代码，再做最终 API 类型检查。最终必要定向结果为 15 个测试文件、155 passed / 0 failed / 0 skipped；API 类型检查、15 个相关文件的 ESLint、迁移静态 lint 均 exit 0。覆盖有效要求正反例、Journey/时效/系列计划旧消费者、Full 风险映射、迁移清单与静态权限 inventory。

新增 `bulk-preshrink-correction-postgres.test.ts` 的五个实际数据库用例已能由 Vitest 发现，但未执行数据库：精确原 v3 + 无权/伪 Root/错误关联/过期依据 + 七阶段回滚 + 并发幂等；确需预缩正控；真实完成不可抹除；纠正不代替验布许可；已发布版本变化拒绝。列表发现或静态检查都不表示 PG 通过。

本环境未启动 PostgreSQL。按用户授权，各自精确最终 head 的 GitHub 官方 Full 使用仓库 canonical runner 执行所需 PG、权限及兼容检查；不得复用另一 PR 或旧 head 的结果。`business-anchors-clock-postgres.test.ts`、production-readiness、sourcing-pr03、新纠正 suite 及其共享 fixture 已进入规范风险映射；Journey PG13 等原有必要阶段继续保留。

GitHub light、必要 Codex Review、协调方具体收口、原 controller 最终 Full 及其真实回执仍须逐项核验；本文件不称这些门禁已通过，也不授权执行实际旧单纠正。
