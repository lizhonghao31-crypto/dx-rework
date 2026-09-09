# 达兴数字助手平台权限 Golden Source V1.0

**状态：** 生效中的平台级权限基线；未明确批准的条目不得据此判定实现错误  
**建立日期：** 2026-09-09  
**适用仓库：** `lizhonghao31-crypto/dx-rework`  
**目的：** 为 Acceptance Lab、权限审计、UI 准入、HTTP Route、Service、PostgreSQL 约束和 Todo 路由提供同一套业务权限标准。

> 本文件是“权限标准”的最高入口。Acceptance Matrix 只能把本文件中 **APPROVED** 的规则翻译为机器检查，不能根据当前 `role_capabilities`、现有页面、现有 API、测试现状或开发者判断反向生成标准。

## 0. 权威顺序

发生冲突时按以下顺序处理：

1. 本文件中状态为 **APPROVED** 的平台权限规则；
2. 已批准的模块 Golden Source / requirement 文件中的更细业务规则；
3. Acceptance Matrix 机器检查定义；
4. 当前数据库 `role_capabilities`、前端导航、API 实现和测试现状。

第 3、4 项永远不能反向覆盖第 1、2 项。

## 1. 规则状态

每条权限规则必须显式标记以下状态之一：

- **APPROVED**：有可追溯的业务批准来源；Acceptance Lab 可以据此判定 `pass/fail`，不一致可以进入权限治理。
- **PENDING**：当前缺少明确业务批准或来源存在冲突；Acceptance Lab 只能显示“标准待确认”，不得算作权限缺陷、P1/P2，也不得为变绿而修改正式权限。
- **RETIRED**：已被更新规则替代，不再作为当前标准。

新增或修改权限标准必须先更新本文件或对应模块 Golden Source，再修改 Acceptance Matrix 和实现代码。

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
2. IE：审核价格；
3. 生产管理：调整价格、选供应商、确认工艺；
4. 老板：批准/驳回；
5. 财务：后置只读核对，不参与派单放行。

### PERM-SOURCING-DAXING-PRICE-001 · 达兴价格敏感字段

**状态：APPROVED**  
**来源：** `docs/requirements/sourcing-supplier-production-v1.0.md` 的达兴价格权限条款

- 达兴价格仅向该订单的跟单、IE、生产管理、老板、财务和 Root 展示；
- 普通工人、仓管、驻厂生产填报人员及其他无外发五节点权限者不得查看；
- 后端响应也不得向无权角色返回该字段；
- 达兴价格不得进入合同、供应商生产页面或供应商发货凭证。

### PERM-SUPPLIER-OWNER-001 · 老板供应商业务读取

**状态：APPROVED**  
**来源：** `docs/requirements/authorization-policy-2026-08-08.md` §3；`docs/requirements/sourcing-supplier-production-v1.0.md` §4

老板可读取供应商业务事实和供应商中心。

### PERM-SUPPLIER-SOURCING-001 · 外发业务角色供应商资料使用

**状态：APPROVED（按业务所需读取范围）**  
**来源：** `docs/requirements/sourcing-supplier-production-v1.0.md` §4—§5

跟单、IE、生产管理、老板以及外发付款核对相关财务角色，可以在其外发职责需要的范围内读取供应商资料。合同敏感资料、内部价格及写权限必须继续按独立规则限制。

### PERM-SUPPLIER-TAIL-001 · 尾部主管是否可进入完整供应商中心

**状态：PENDING**  
**原因：** 当前 Acceptance Matrix 写成“禁止供应商中心/供应商目录”，但现有需求文件未找到足以证明该平台级禁止规则的明确业务批准；返工业务又存在读取供应商目录用于责任/工厂选择的历史能力，不能直接把基础目录读取等同于供应商中心越权。

在业务负责人明确批准前：

- Acceptance Lab 不得把尾部主管可读取 `master-data/suppliers` 或出现供应商相关入口直接判为 P1/P2；
- 不得为了矩阵变绿撤销正式权限；
- 后续需明确区分“返工场景供应商选择数据”与“供应商中心完整资料”的数据范围。

### PERM-SUPPLIER-QC-001 · 质检是否可进入完整供应商中心

**状态：PENDING**  
**原因：** 与 `PERM-SUPPLIER-TAIL-001` 相同；当前缺少明确业务批准，且质检在返工发起/责任上下文中可能需要基础供应商目录。

在业务负责人明确批准前，不得将当前实现直接判为权限泄漏。

### PERM-SUPPLIER-WORKER-001 · 工人完整供应商中心准入

**状态：PENDING**  
**原因：** 已批准来源明确禁止普通工人读取达兴价格，但没有找到足以把“不得看达兴价格”扩大解释成“绝对不得进入任何供应商基础资料页面”的业务批准。

已确定的硬边界只有：普通工人不得读取达兴价格、供应商合同敏感资料或获得供应商维护写权限。完整供应商中心是否全部禁止，待业务负责人确认。

### PERM-SUPPLIER-WAREHOUSE-001 · 仓管完整供应商中心准入

**状态：PENDING**  
**原因：** 已批准来源明确禁止仓管读取达兴价格，但订单回货业务本身需要供应商名称/订单关联事实；当前没有足以证明“仓管绝对不得进入任何供应商基础资料页面”的独立批准规则。

已确定的硬边界只有：仓管不得读取达兴价格、供应商合同敏感资料或获得供应商维护写权限。完整供应商中心是否全部禁止，待业务负责人确认。

### PERM-PRODUCTION-REPORTER-001 · 驻厂生产填报最小范围

**状态：APPROVED**  
**来源：** `docs/requirements/sourcing-supplier-production-v1.0.md` §4.2、达兴价格隔离规则

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

设计师拥有样衣业务所需的基本查看及按样衣流程明确赋予的借出/归还发起能力；不因设计师角色获得样衣财务信息。

### PERM-SAMPLE-ADMIN-001 · 样衣行政

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md`

样衣行政负责样衣实物管理、借还确认及按规则发起处置等行政动作；不等同于平台 `system_admin`。

### PERM-SAMPLE-FINANCE-001 · 样衣财务

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md`

`sample_finance` 是独立样衣财务角色，可读取样衣基本/财务信息并执行模块 Golden Source 明确允许的财务维护；不得被 `finance_director` 替代。

### PERM-SAMPLE-APPROVER-001 · 样衣审批

**状态：APPROVED**  
**来源：** `docs/requirements/sample-system-migration-v1.0.md`

样衣处置/出售等审批必须按模块 Golden Source 由老板/Root 等批准身份执行；不得因为样衣审批能力扩展其他模块权限。

## 5. 返工与财务查看

### PERM-REWORK-FINANCE-DIRECTOR-001 · 财务总监返工全量只读

**状态：APPROVED**  
**来源：** `docs/roadmap/role-ui-access-audit-20260908.md` 权限治理02

财务总监可读取返工管理列表和返工业务详情；仅为全量只读，不新增返工写权限。

### PERM-REWORK-FINANCE-READ-001 · 普通财务查看不自动升级为财务总监

**状态：APPROVED**  
**来源：** `docs/roadmap/role-ui-access-audit-20260908.md` 权限治理02

`finance_read` 保持其既有工资/报表事实范围，不因财务总监获得全量返工详情而同步提权。

### PERM-REWORK-WORKER-001 · 工人返工任务范围

**状态：APPROVED（仅返工任务范围）**  
**来源：** 返工业务既有角色模型

工人只执行分配给自己的返工任务和个人上数/计薪相关动作。

### PERM-PLATFORM-WORKER-CROSSMODULE-001 · 工人跨模块禁止范围

**状态：PENDING**  
**原因：** 当前 Acceptance 代表场景把供应商、样衣、生产看板和人员权限管理全部列为禁止入口，但该组合禁止规则尚未逐条追溯到业务 Golden Source；在逐条确认前不能因为某个入口存在就直接判定实现错误。

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

发现实现与批准标准不一致时，修改正式权限实现；不得静默修改 Golden Source 或 Acceptance Matrix 预期来消除失败。

## 7. 当前待业务确认项

当前 V1.0 明确保留以下待确认项，不做默认推断：

| 规则 ID | 问题 | 当前状态 |
|---|---|---|
| `PERM-SUPPLIER-TAIL-001` | 尾部主管能否进入完整供应商中心；若仅需返工选择供应商，允许的数据范围到哪里 | PENDING |
| `PERM-SUPPLIER-QC-001` | 质检能否进入完整供应商中心；若仅需返工发起/责任上下文读取供应商，允许的数据范围到哪里 | PENDING |
| `PERM-SUPPLIER-WORKER-001` | 普通工人是否完全禁止供应商基础资料入口，还是只禁止敏感字段/维护能力 | PENDING |
| `PERM-SUPPLIER-WAREHOUSE-001` | 仓管是否完全禁止供应商基础资料入口，还是只允许订单回货所需关联事实 | PENDING |
| `PERM-PLATFORM-WORKER-CROSSMODULE-001` | 工人对样衣、实时生产、人员权限等跨模块入口的逐项批准依据 | PENDING |

后续业务负责人给出结论时，只更新相应规则状态和范围，不重写整套权限模型。

## 8. 变更纪律

1. 权限需求变化：先更新 Golden Source，再施工实现；
2. 每条新规则必须有唯一 ID、状态、来源和明确范围；
3. Acceptance Matrix 必须引用规则 ID；
4. PENDING 规则不得作为 PR 阻断或缺陷等级依据；
5. 涉及敏感字段、跨模块读取、审批、金额或人员权限的变更必须做服务端/数据库边界验证；
6. Root 继续遵循 `authorization-policy-2026-08-08.md` 的特殊身份规则，不把 Root 当普通角色模板修改。
