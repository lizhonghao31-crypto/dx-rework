# 达兴数字助手平台权限 Golden Source V1.0

**状态：** 生效中的平台级权限索引；未明确批准的条目不得据此判定实现错误  
**建立日期：** 2026-09-09  
**适用仓库：** `lizhonghao31-crypto/dx-rework`  
**目的：** 为 Acceptance Lab、权限审计、UI 准入、HTTP Route、Service、PostgreSQL 约束和 Todo 路由提供同一套可追溯权限标准入口。

> 本文件是平台权限的统一索引和跨模块归一层，不覆盖 `AGENTS.md` 指定的模块 Golden Source。Acceptance Matrix 只能把 **APPROVED** 规则翻译为机器检查，不能根据当前 `role_capabilities`、现有页面、现有 API、测试现状或开发者判断反向生成标准。

## 0. 权威顺序

发生冲突时按以下顺序处理：

1. `AGENTS.md` 指定的当前业务 Golden Source；其中样衣规则以 `docs/requirements/sample-system-migration-v1.0.md` 为准，外发定价、供应商中心、合同、正式派单、生产填报与实时看板以 `docs/requirements/sourcing-supplier-production-v1.0.md` 为准，返工及其他平台规则按 `AGENTS.md` 指向的当前基线执行；
2. 本文件中状态为 **APPROVED** 的跨模块权限归一规则和对上述 Golden Source 的索引；本文件不得扩大、缩小或覆盖第 1 项；
3. 其他已批准 ADR / roadmap 中尚未归并回模块 Golden Source 的明确增量规则；
4. Acceptance Matrix 机器检查定义；
5. 当前数据库 `role_capabilities`、前端导航、API 实现和测试现状。

如果本文件与第 1 项存在冲突，必须修正本文件；不得以本文件覆盖模块 Golden Source。第 4、5 项永远不能反向覆盖业务标准。

## 1. 规则状态

每条权限规则必须显式标记以下状态之一：

- **APPROVED**：有可追溯的业务批准来源；Acceptance Lab 可以据此判定 `pass/fail`，不一致可以进入权限治理。
- **PENDING**：当前缺少明确业务批准或来源存在冲突；Acceptance Lab 只能显示“标准待确认”，不得算作权限缺陷、P1/P2，也不得为变绿而修改正式权限。
- **RETIRED**：已被更新规则替代，不再作为当前标准。

新增或修改权限标准必须先更新模块 Golden Source 或本文件对应跨模块规则，再修改 Acceptance Matrix 和实现代码。

## 2. 平台通用硬规则

### PERM-PLATFORM-ROOT-001 · Root 全局准入

**状态：APPROVED**  
**来源：** `docs/requirements/authorization-policy-2026-08-08.md` §1

- Root 是系统最高授权身份，不是普通角色模板；
- Root 可进入全部业务页面和技术管理页面；
- Root 身份必须保留审计；
- Root 不代表可破坏历史不可变、独立确认等硬业务完整性约束。

### PERM-PLATFORM-OWNER-001 · 老板业务最高权限

**状态：APPROVED**  
**来源：** `docs/requirements/authorization-policy-2026-08-08.md` §3

- `owner_group` 可读取全部业务事实和业务页面；
- 可进入管理 Dashboard、业务明细、报表、业务基础资料和员工权限管理；
- 不因老板角色获得 `system_admin` 技术异常处置能力；
- 不得绕过独立确认、自批限制或历史不可变规则。

### PERM-PLATFORM-SYSADMIN-001 · 系统管理员非业务超级用户

**状态：APPROVED**  
**来源：** `docs/requirements/authorization-policy-2026-08-08.md` §4

- `system_admin` 负责系统管理后台、技术异常受控重试、审计日志和明确授权的系统级维护；
- 不自动拥有管理 Dashboard、业务全量查看、工资/责任/扣款等业务操作；
- 不自动拥有业务基础资料维护、员工业务角色管理或老板权限。

### PERM-PLATFORM-LAYER-001 · 分层鉴权一致

**状态：APPROVED**  
**来源：** `docs/requirements/authorization-policy-2026-08-08.md` §7

同一权限必须在前端、HTTP Route、Service、PostgreSQL 和 Todo 路由保持一致；前端隐藏按钮不是安全边界。

## 3. 外发定价 / 供应商 / 实时生产

### PERM-SOURCING-FIVE-001 · 外发五节点参与角色

**状态：APPROVED**  
**来源：** `docs/requirements/sourcing-supplier-production-v1.0.md` §5

五节点参与角色：

1. 跟单：创建订单；
2. IE：审核价格，只审核价格，不选择供应商；
3. 生产管理：调整价格并选择供应商；
4. 老板：批准/驳回并查看供应商等决策摘要；
5. 财务：后置只读核对订单中的供应商、逐款价格、数量、合同总额和系统合同 PDF，不参与派单放行。

这条规则只批准各角色在**订单上下文**中的上述事实和动作，不自动授予供应商主档/供应商中心完整读取权限。

### PERM-SOURCING-DAXING-PRICE-001 · 达兴价格敏感字段

**状态：APPROVED**  
**来源：** `docs/requirements/sourcing-supplier-production-v1.0.md` §6.3

- 达兴价格仅向该订单的跟单、IE、生产管理、老板、财务和 Root 展示；
- 普通工人、仓管、驻厂生产填报人员及其他无外发五节点权限者不得查看；
- 后端响应也不得向无权角色返回该字段；
- 达兴价格不得进入合同、供应商生产页面或供应商发货凭证。

### PERM-SUPPLIER-OWNER-001 · 老板供应商主档读取

**状态：APPROVED**  
**来源：** `docs/requirements/authorization-policy-2026-08-08.md` §3

老板作为业务最高权限可读取业务基础资料，因此可读取供应商主档/供应商中心；写能力仍按供应商主档独立写 capability 和审计规则控制。

### PERM-SUPPLIER-ORDER-CONTEXT-001 · 外发订单上下文中的供应商事实

**状态：APPROVED**  
**来源：** `docs/requirements/sourcing-supplier-production-v1.0.md` §5.1—§5.6

- 生产管理可在节点 3 为订单选择一个供应商；
- 老板可在审批摘要中读取该订单供应商；
- 财务可在后续对账中只读核对该订单供应商及合同事实；
- 跟单在正式派单前确认已经批准的供应商；
- IE 只审核价格，不选择供应商。

本规则不等于 `master-data/suppliers`、供应商详情、联系人、地址、收款资料或变更历史的完整读取许可。订单选择器应优先使用满足业务需要的最小供应商候选契约。

### PERM-SUPPLIER-PM-CENTER-001 · 生产管理完整供应商中心准入

**状态：PENDING**  
**原因：** 生产管理明确需要“选供应商”，但模块 Golden Source 没有把这个需求等同于完整供应商主档/联系人/合同与收款资料读取。完整中心范围需要业务负责人单独确认。

### PERM-SUPPLIER-MERCH-CENTER-001 · 跟单完整供应商中心准入

**状态：PENDING**  
**原因：** 跟单在节点 1 不选供应商，正式派单只确认已批准供应商；现有 Golden Source 未明确授予完整供应商主档读取。

### PERM-SUPPLIER-IE-CENTER-001 · IE 完整供应商中心准入

**状态：PENDING**  
**原因：** 模块 Golden Source 明确 IE 只审核价格、不选择供应商；没有找到完整供应商主档读取的批准依据。当前实现若允许，不能仅因实现存在就反向固化为标准。

### PERM-SUPPLIER-FINANCE-CENTER-001 · 财务完整供应商中心准入

**状态：PENDING**  
**原因：** 财务被批准的是订单上下文中供应商、价格、数量、合同总额和合同 PDF 的只读核对，没有明确授予供应商主档/联系人/地址/收款资料/历史版本的完整读取。

### PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001 · 加工厂应付会计完整供应商中心准入

**状态：PENDING**  
**原因：** 当前平台实现存在该角色的供应商读取 capability，但未找到足以把完整供应商中心准入作为业务标准的模块 Golden Source 条款。

### PERM-SUPPLIER-TAIL-001 · 尾部主管完整供应商中心准入

**状态：PENDING**  
**原因：** 当前 Acceptance Matrix 写成“禁止供应商中心/供应商目录”，但现有业务 Golden Source 未找到明确的完整中心禁止条款。

返工需要供应商选择数据时已有面向返工上下文的最小 `supplier-options` 类契约；这种业务需要**不能**作为 `master-data/suppliers` 或供应商详情完整读取的批准依据。反过来，没有明确禁止条款也不能仅凭矩阵现状把当前 200 直接定为 P1/P2。该完整中心准入需要业务负责人确认。

### PERM-SUPPLIER-QC-001 · 质检完整供应商中心准入

**状态：PENDING**  
**原因：** 与 `PERM-SUPPLIER-TAIL-001` 相同。返工发起/责任上下文若需要供应商基础选项，应使用最小业务契约；这不证明完整供应商中心应当开放，也不构成现阶段已批准的禁止规则。

### PERM-SUPPLIER-WORKER-001 · 工人完整供应商中心准入

**状态：PENDING**  
**原因：** 已批准来源明确禁止普通工人读取达兴价格，但没有找到足以把“不得看达兴价格”扩大解释成“绝对不得进入任何供应商基础资料页面”的业务批准。

已确定的硬边界只有：普通工人不得读取达兴价格；供应商合同/收款等敏感资料及维护能力必须另有明确授权。完整供应商中心是否全部禁止，待业务负责人确认。

### PERM-SUPPLIER-WAREHOUSE-001 · 仓管完整供应商中心准入

**状态：PENDING**  
**原因：** 已批准来源明确禁止仓管读取达兴价格，但订单回货业务本身需要供应商名称/订单关联事实；当前没有足以证明“仓管绝对不得进入任何供应商基础资料页面”的独立批准规则。

已确定的硬边界只有：仓管不得读取达兴价格；供应商合同/收款等敏感资料及维护能力必须另有明确授权。完整供应商中心是否全部禁止，待业务负责人确认。

### PERM-PRODUCTION-REPORTER-001 · 驻厂生产填报最小范围

**状态：APPROVED**  
**来源：** `docs/requirements/sourcing-supplier-production-v1.0.md` §4.2、§6.3

驻厂生产填报人员只维护其生产填报职责需要的数据；不因生产填报角色获得外发定价、供应商合同资料或达兴价格。

## 4. 样衣模块

### PERM-SAMPLE-FINANCE-DIRECTOR-001 · 财务总监样衣严格只读

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md` 2026-09-09 V1.3 权限增量

`finance_director` 必须拥有：

- `sample:view_basic`
- `sample:view_finance`
- `sample:view_audit`

并且不得拥有任何样衣写能力，包括新增、批量新增、借还/交接、基本资料/位置修改、采购价/小票修改、财务修正、处置、审批、遗失结案、归档/恢复。

### PERM-SAMPLE-DESIGNER-001 · 样衣设计师

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md`

设计师拥有模块 Golden Source 明确授予的基本查看及借出/归还发起能力；是否能读取财务字段、执行其他动作，以模块 Golden Source 的具体 capability 表为准。

### PERM-SAMPLE-ADMIN-001 · 样衣行政

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md`

样衣行政负责模块 Golden Source 明确授予的样衣实物管理、借还确认及处置发起等行政动作；不等同于平台 `system_admin`。

### PERM-SAMPLE-FINANCE-001 · 样衣财务

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md`

`sample_finance` 是独立样衣财务角色，可读取和维护的字段、动作严格以模块 Golden Source 为准；不得被 `finance_director` 替代。

### PERM-SAMPLE-APPROVER-001 · 样衣审批

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md`

样衣处置/出售等审批必须按模块 Golden Source 由批准身份执行；不得因为样衣审批能力扩展其他模块权限。

## 5. 返工、工资与财务查看

### PERM-REWORK-FINANCE-DIRECTOR-001 · 财务总监返工全量只读

**状态：APPROVED**  
**来源：** `docs/roadmap/role-ui-access-audit-20260908.md` 权限治理02

财务总监可读取返工管理列表和返工业务详情；仅为全量只读，不新增返工写权限。

### PERM-REWORK-FINANCE-READ-001 · 普通财务查看不自动升级为财务总监

**状态：APPROVED**  
**来源：** `docs/roadmap/role-ui-access-audit-20260908.md` 权限治理02

`finance_read` 保持其既有工资/报表事实范围，不因财务总监获得全量返工详情而同步提权。

### PERM-WAGE-MONTH-CLOSE-EXPORT-001 · 工资月结会计工资导出

**状态：APPROVED**  
**来源：** 2026-09-09 业务负责人明确确认

- `wage_month_close_accountant` 保持现有 `wage:view`；
- 必须拥有 `wage:export`，可使用现有“导出当前工资明细”功能；
- 该角色业务显示名称统一为“工资月结会计”；
- 不因此新增工资修改、工资月结流程、其他模块或人员权限。

### PERM-REWORK-WORKER-001 · 工人返工任务范围

**状态：APPROVED（仅返工任务范围）**  
**来源：** 返工业务当前 Golden Source / 已批准角色模型

工人只执行分配给自己的返工任务和个人上数/计薪相关动作；本规则不自动推导其他一级模块的全量禁止列表。

### PERM-PLATFORM-WORKER-CROSSMODULE-001 · 工人跨模块禁止范围

**状态：PENDING**  
**原因：** 当前 Acceptance 代表场景把供应商、样衣、生产看板和人员权限管理全部列为禁止入口，但该组合禁止规则尚未逐条追溯到对应模块 Golden Source；在逐条确认前不能因为某个入口存在就直接判定实现错误。

## 6. Acceptance Matrix 使用规则

### PERM-ACCEPTANCE-001 · 只有 APPROVED 规则可以判 fail

**状态：APPROVED**  
**来源：** 本文件建立时业务负责人确认

- Acceptance Matrix 的每个业务权限检查必须可追溯到本文件或模块 Golden Source 的规则 ID；
- **APPROVED**：实际与标准不一致时可判 `fail`；
- **PENDING**：只能显示“标准待确认”，不得计入失败数；
- 没有规则 ID 的业务权限检查视为矩阵缺陷，不得据此修改正式权限；
- 身份切换、Session 用户一致、Root 不继承等 Acceptance 基础设施完整性检查可以由 Acceptance Lab 自身安全规则直接判定。

### PERM-ACCEPTANCE-002 · 不允许为变绿修改标准

**状态：APPROVED**  
**来源：** `docs/roadmap/acceptance-lab-20260908-v1.0.md` §3

发现实现与批准标准不一致时，修改正式权限实现；不得静默修改模块 Golden Source、本文件或 Acceptance Matrix 预期来消除失败。

### PERM-ACCEPTANCE-UNMAPPED-001 · 未绑定业务来源的检查隔离

**状态：APPROVED**  
**来源：** `PERM-ACCEPTANCE-001` 的机器执行细化

- 业务检查尚未绑定具体 Golden Source 规则 ID 时，机器仍可执行并记录预期/实际，但 verdict 必须为 `pending`；
- 这类检查必须显示“尚未绑定业务标准”，不得计入通过或失败；
- 在补齐规则来源前，不得依据该检查修改正式权限；
- 该治理规则本身不是业务权限标准，只用于阻止未追溯的机器预期产生假绿或假红。

## 7. 当前待业务确认项

当前 V1.0 明确保留以下待确认项，不做默认推断：

| 规则 ID | 问题 | 当前状态 |
|---|---|---|
| `PERM-SUPPLIER-PM-CENTER-001` | 生产管理为了选厂可以看到供应商主档到什么范围；是否允许进入完整供应商中心 | PENDING |
| `PERM-SUPPLIER-MERCH-CENTER-001` | 跟单是否需要完整供应商中心，还是只需订单已批准供应商事实 | PENDING |
| `PERM-SUPPLIER-IE-CENTER-001` | IE 是否需要完整供应商中心；现有 Golden Source 只批准其审核价格 | PENDING |
| `PERM-SUPPLIER-FINANCE-CENTER-001` | 财务是否需要完整供应商中心；现有 Golden Source 只批准订单/合同上下文核对 | PENDING |
| `PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001` | 加工厂应付会计完整供应商中心的数据范围 | PENDING |
| `PERM-SUPPLIER-TAIL-001` | 尾部主管能否进入完整供应商中心 | PENDING |
| `PERM-SUPPLIER-QC-001` | 质检能否进入完整供应商中心 | PENDING |
| `PERM-SUPPLIER-WORKER-001` | 普通工人是否完全禁止供应商基础资料入口，还是只禁止敏感字段/维护能力 | PENDING |
| `PERM-SUPPLIER-WAREHOUSE-001` | 仓管是否完全禁止供应商基础资料入口，还是只允许订单回货所需关联事实 | PENDING |
| `PERM-PLATFORM-WORKER-CROSSMODULE-001` | 工人对样衣、实时生产、人员权限等跨模块入口的逐项批准依据 | PENDING |

后续业务负责人给出结论时，只更新相应规则状态和范围，不重写整套权限模型。

## 8. 变更纪律

1. 模块权限需求变化：先更新对应模块 Golden Source；跨模块归一规则同步更新本文件；
2. 每条新规则必须有唯一 ID、状态、来源和明确范围；
3. Acceptance Matrix 必须引用规则 ID；
4. PENDING 规则不得作为 PR 阻断或缺陷等级依据；
5. 涉及敏感字段、跨模块读取、审批、金额或人员权限的变更必须做服务端/数据库边界验证；
6. Root 继续遵循 `authorization-policy-2026-08-08.md` 的特殊身份规则，不把 Root 当普通角色模板修改。