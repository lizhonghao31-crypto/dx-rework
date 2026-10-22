# main → Acceptance 后续同步计划（仅只读核对，未执行同步）

2026-10-22核对的远端 `release/digital-production-v1` 为 `4c731753b51e5f3b163e563457eb8f425bf9e603`；manifest包含260项，末项为`0250_todo_content_reads`。此处是分支源码事实，不代表Acceptance实例的实际部署版本或数据库已应用库存。本轮未连接Acceptance/ECS，不恢复旧OOM任务。

main的PR01 #847、PR02 #848及本轮PR03均尚未同步到Acceptance，也未合并main。main更新不会自动更新Acceptance。本文件只准备后续步骤；未获额外同步PR、合并或部署授权，不能直接执行下面的迁移集成。

## 已确认的编号冲突

| main本轮迁移 | Acceptance已有同编号迁移 | 已有校验和 |
|---|---|---|
| 0228_sourcing_contract_return_cycles | 0228_digital_bulk_preparation | c50f93ea731b5e9e2b8cab781ad870bb53a1bef8271b913720d63d6efb5e7bb6 |
| 0229_sourcing_price_reapplications | 0229_digital_bulk_cutting | be60e800d1c513da9ae9e25463eba2a92d9ca69b86489f847269743d0e1672bb |

完整版本名不同，但当前迁移治理需要显式登记并行身份，不能仅凭文件名不同就直接cherry-pick。Acceptance现有`migration-main-extensions.json`只登记main增量至0227。两个本轮新表`Sourcing contract return cycles`（数据库名`sourcing_contract_return_cycles`）及`sourcing_price_reapplications`均未出现在该Acceptance迁移库存。

## 建议的身份映射和桥接

1. 待用户另行授权，从届时最新Acceptance分支创建独立同步分支，先冻结三个main PR的最终HEAD及migration checksum；按PR01→PR02→PR03合并业务差异，人工保留Acceptance的数字生产、剩余执行、客户PO、工厂日期、身份刷新等已确认规则。不要以整文件覆盖main/release差异。
2. 保留main `0228_sourcing_contract_return_cycles`、`0229_sourcing_price_reapplications`原完整版本名及各自原校验和，登记为main extension lane；Acceptance原`0228_digital_bulk_preparation`、`0229_digital_bulk_cutting`及其余已执行迁移逐字保留。不要把已在main执行的SQL改号、改内容，或制造一个同义复制迁移再次创建相同表。
3. 更新集成manifest及迁移身份治理，接受现存两条完整历史的合法前缀、lane顺序和后续桥接。当前库存下下一尾号为0251；只能在获准施工时重新核对后分配尾部桥接迁移，不能现在占用或宣称已存在。桥接恢复/合并Acceptance的新规则以及本轮price source、周期及并发保护，不删改旧收据。
4. 必须逐函数合并：Acceptance `guard_sourcing_decision_insert()`最后由0236重定义，`guard_sourcing_transition_insert()`及`sourcing_effective_delivery_date()`最后由0241重定义；main0229的基础guard不能覆盖掉这些Acceptance语义。其他约束、工艺/裁床保护、合同人工内容和剩余执行也须按当前源核对。原main增量安装及尾部兼容桥接在同次静止维护内完成，未到最终schema及代码一致状态前不恢复服务。
5. 在隔离PG13构造库验证两条真实迁移历史分别升级至同一集成manifest：main0229→集成，Acceptance0250→集成；原version/checksum/applied_at全部保留，新迁移仅执行一次，重跑零新增，漂移和未知库存拒绝。再验证数字生产正常路径与本轮81项外发、真实历史三单范围/27单保护、状态/通知、并发、两线工具版本和回退语义。
6. 最后形成一个独立同步PR，按风险运行一次收敛后的Full Gate及必要Review。获准合并后，Acceptance部署仍需用户单独执行其匹配的维护工具；不能使用本轮main229生产更新脚本，不借恢复旧OOM任务来同步。

## 防止将来反向覆盖

以后release回main前，应以三个已合并main修复作为必须保留的基线，并审查它们在集成分支中的对应行为及测试。保留原main迁移身份意味着已有main库不会重建周期/价格表，尾部桥接负责合并后的守卫语义。集成差异中不允许回退三单allowlist、业务周期适用资格、显式恢复、旧27单兼容、价格事务锁/稳定生成请求、真实调价来源或Root边界。相关Gate未覆盖时不能声称同步完成。
