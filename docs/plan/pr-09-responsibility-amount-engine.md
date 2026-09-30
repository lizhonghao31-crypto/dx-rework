# PR-09 责任判定与金额引擎施工契约

> 路线ID：PR-09  
> Repository：`lizhonghao31-crypto/dx-rework`  
> Base：`main@33aec639fbf5964e1039a4443bae4a6df74ac8e8`  
> 前置条件：PR-08 已合并，返工单经整单审核后进入 `pending_responsibility_determination`。  
> 需求基线：`docs/requirements/startup-requirements-v1.2.md` 8.5、8.6、8.7、9 及路线图 v2.0。

## 1. 本 PR 的唯一业务目标

在不提前实现 PR-10 本厂承担审批、PR-11 外部签收/实际扣款、PR-12 工资月结的前提下，完成：

1. 按工序判定责任；
2. 同一工序支持多个责任类型按比例承担；
3. 按工序设置倍率，并支持批量应用倍率；
4. 按“上数记录 × 工人快照 × 责任分配行”计算责任金额；
5. 保存逐行计算快照、舍入结果和汇总；
6. 支持生产管理默认处理、老板权限组介入/接管、显式转交；
7. 已判定责任不得被覆盖，后续变更必须形成新版本并关联原版本。

## 2. 明确排除

本 PR 不实现：

- 本厂承担最终审批；
- 跟单选择具体供应商；
- 供应商签收、应付确认、拟扣或实际扣款；
- 工资核对、月结、锁定和工资导出；
- 完整钉钉待办、催办；
- Dashboard、综合导出；
- ERP 接入或生产部署。

## 3. 身份、权限与接管

### 3.1 能力

新增并由服务端独立校验：

- `responsibility:determine`：保存、提交责任判定；授予 `production_management`、`owner_group`；允许有效的返工单范围代理。
- `responsibility:takeover`：老板介入/接管；仅授予 `owner_group`。
- `responsibility:confirm_high_multiplier`：确认超过 2 倍的责任判定；仅授予 `owner_group`。

`system_admin` 不得凭管理员身份绕过业务能力。

### 3.2 默认处理、转交与接管

- 默认责任判定角色为 `production_management`，不得按姓名硬编码张文豪。
- 老板权限组可主动接管；接管必须记录原处理人、新处理人、原因、actor、角色/能力快照和时间。
- 当前处理人可将责任判定显式转交给具备 `responsibility:determine` 的有效用户；目标用户必须为当前组织内、在职、启用且有对应能力。
- 任何转交或接管均不得修改历史判定版本，只改变后续草稿的处理人快照。

## 4. 责任类型与供应商边界

PR-09 只保存责任分类，不选择具体供应商。责任类型固定为：

- `own_factory`：本厂；
- `processing_factory`：外发加工厂；
- `embroidery_factory`：印绣花厂；
- `washing_factory`：洗水厂；
- `fabric_supplier`：面料商。

具体供应商、拟扣对象和实际扣款由 PR-11 以独立后续记录补充，不得回写覆盖 PR-09 的原始责任分类。

## 5. 比例、倍率与完整性

### 5.1 承担比例

- 每个当前 approved 工序必须至少有一条责任分配；
- 使用整数 basis points 保存比例：`1% = 100 bps`，每个工序合计必须严格等于 `10000 bps`；
- 单条比例必须大于 0；
- 不使用二进制浮点比较比例总和；
- 同一工序允许多个不同责任类型；同一责任类型在同一判定版本、同一工序中只允许一条，避免重复含义。

### 5.2 倍率

- 倍率按工序设置，必须 `>= 1`；
- 常用快捷值：`1`、`1.2`、`1.3`、`1.5`、`2`；
- 允许批量把同一倍率应用到多个工序；批量操作只是生成同一不可变草稿快照，不得绕过逐工序校验；
- 倍率最多保留 3 位小数；
- 倍率 `> 2` 时必须填写原因，并进入独立二次确认；确认人必须具备 `responsibility:confirm_high_multiplier`，且不得与该版本提交人相同；
- 未完成二次确认的版本不得正式判定。

## 6. 金额计算与舍入

### 6.1 计算粒度

以每条有效、未驳回的上数记录中的每名成员分摊为基础行：

```text
责任金额行
= 工人该条上数分摊金额 × 工序倍率 × 责任方比例
```

- 个人任务使用该上数记录唯一成员的分摊金额；
- 集体任务使用 PR-07 已保存的每名成员分摊快照；不得按当前任务成员重新计算；
- 已驳回的上数记录不参与；重新提交记录按新记录计算，旧记录永久保留但不参与当前有效判定；
- PR-09 不改变工人工资金额，责任金额仅表示承担/拟扣基数。

### 6.2 精度与舍入

- 全部计算使用十进制整数/BigInt 或数据库 numeric，不得使用 `Math.round(number * 100)` 作为金额核心算法；
- 每条“上数记录 × 工人 × 责任分配”独立执行四舍五入（half-up）到 2 位小数；
- 工序责任方金额为已舍入责任行之和；
- 工序责任总额为各责任方已舍入金额之和；
- 整单责任总额为各工序已舍入金额之和；
- 数据库必须保存：基础分摊金额、倍率、比例 bps、未舍入计算值、最终 2 位责任金额、舍入规则和输入快照；
- 汇总不得重新对总额乘倍率和比例后一次舍入。

## 7. 版本、不可变历史与状态

- 责任判定采用 append-only 版本；保存草稿、正式判定、变更均创建新版本，不原地覆盖历史版本和金额行；
- 每个版本保存来源 `order_review_id`、approved 工序快照、有效上数/成员分摊快照、处理人、提交人、接管/转交来源及原因；
- 新版本通过 `replaces_determination_id` 关联被替代版本；原版本内容保持不可变；
- 同一返工单同一时间最多一个活动草稿，服务层和数据库并发守卫均须保证；
- 正式判定前返工单必须为 `pending_responsibility_determination`，且 PR-08 整单审核记录存在；
- 正式判定后返工单进入 `pending_responsibility_action`，仅表示等待后续本厂审批或外部签收，不提前实现后续生命周期；
- 若在后续节点创建责任变更草稿，必须记录原因并返回 `pending_responsibility_determination`；旧正式判定不删除、不覆盖。

## 8. 数据库最低要求

新增前向迁移 `0010_responsibility_determination_amount_engine`，至少包含：

1. 责任判定版本表；
2. 工序倍率快照表；
3. 工序责任分配表；
4. 工人/上数粒度责任金额行表；
5. 处理人转交/接管事件表，或等价的不可变版本快照；
6. 超 2 倍二次确认快照；
7. 当前活动草稿唯一性、比例合计、工序归属、来源整单审核、版本递增、actor/event 一致性和历史不可变守卫；
8. 禁止 UPDATE/DELETE/TRUNCATE 历史判定、分配和金额行；如必须终止草稿，使用追加的终止记录或新版本，不删除原数据；
9. migration manifest checksum 更新。

数据库直接写入即使伪造部分字段，也必须拒绝：跨订单工序、无整单审核、错误订单状态、比例不等于 100%、倍率小于 1、未经二次确认的 >2 倍、提交人与确认人相同、金额行与有效上数/成员快照不一致、持久化 actor 与 operation event actor 不一致。

## 9. API 与 UI 最小交付

### 9.1 API

建议保持一个完整快照式写入模型：

- `GET /rework-orders/:reworkOrderId/responsibility-determination`
- `POST /rework-orders/:reworkOrderId/responsibility-determinations/drafts`
- `POST /rework-orders/:reworkOrderId/responsibility-determinations/finalize`
- `POST /rework-orders/:reworkOrderId/responsibility-determinations/takeover`
- `POST /responsibility-determinations/:determinationId/high-multiplier-confirm`

所有写接口必须使用 `Idempotency-Key`、expected order/determination version、事务和 operation event。

### 9.2 UI

在现有返工详情/责任处理页面增量接入：

- 当前处理人、接管/转交状态；
- 每个工序的已审核计件金额、倍率、责任类型和比例；
- 快捷倍率及批量设置；
- 比例未满/超额提示；
- 逐责任方金额和工序汇总；
- 超 2 倍原因及待确认状态；
- 保存草稿、正式判定、接管入口。

不得重构设计令牌、导航、页面框架或引入新 UI 库。

## 10. 必须覆盖的测试

至少覆盖：

1. 只有整单审核完成的返工单可判责；
2. 每个 approved 工序均需配置责任，且比例严格等于 10000 bps；
3. 多责任方比例拆分正确；
4. 倍率 1、1.2、1.3、1.5、2 计算正确；
5. 批量倍率与逐项设置结果一致；
6. 倍率小于 1 或超过 3 位小数拒绝；
7. >2 倍必须原因、独立 owner 确认，提交人与确认人相同拒绝；
8. 个人上数金额行正确；
9. 集体计件使用历史成员分摊快照，不按当前成员反算；
10. 驳回旧记录不计入，重新提交记录计入；
11. 每行 half-up 到 2 位后再汇总，使用能区分“逐行舍入”和“总额一次舍入”的样例；
12. 各责任行之和与存储汇总一致；
13. 同单并发保存只能产生一个活动草稿；
14. 幂等重放不产生重复版本或金额行；
15. 生产管理默认可判责，owner 可接管，管理员不能绕过；
16. 转交目标无能力、离职、禁用或跨组织时拒绝；
17. 新判定/变更通过新版本关联旧版本，旧版本及金额行不可修改；
18. PostgreSQL 直接 SQL 反例覆盖跨单、比例、倍率、二次确认、金额快照和 actor 绑定；
19. PR-05 至 PR-08 全量回归保持通过；
20. 移动端 390×844、360×800 无横向溢出或关键按钮遮挡。

## 11. 门禁与停止规则

- 单一主执行任务，不启动并行 subagent；
- 完整实现、测试和自检后再创建/更新 Draft PR；
- 先运行 lint、typecheck、build、全量 test、PR-09 定向 PostgreSQL 测试、migration lint/replay、secret scan、diff check、移动端 Golden Source 回归；
- 当前精确 Head 的 Governance、Technical CI、Preview 全绿后停止；
- CI 失败先汇总根因再集中修复，不逐个小问题反复全仓分析；
- CI 全绿前不触发 Codex Review；
- PR-09 因金额、权限和不可变历史属于高风险 PR，最终最多触发一次 Codex Review；Review 意见统一分类并最多一次集中修复，不进入无限循环；
- 不合并、不部署、不启动 PR-10/PR-11/PR-12。
