# 工资模块权限 Golden Source V1.0

**状态：** 生效  
**建立日期：** 2026-09-09  
**适用角色：** `wage_month_close_accountant`  
**目的：** 固定工资月结会计在工资模块的当前只读与导出边界，并作为 Acceptance Lab 和权限实现的业务标准。

## 权威规则

### PERM-WAGE-MONTH-CLOSE-EXPORT-001 · 工资月结会计可查看并导出工资明细

**状态：APPROVED**  
**来源：** 2026-09-09 业务负责人明确确认：“把‘导出当前工资明细’的权限开放给工资月结会计。”

`wage_month_close_accountant` 必须拥有：

- `wage:view`：进入工资管理并查看工资明细；
- `wage:export`：在工资管理列表显示“导出当前工资明细”，并允许调用工资 Excel 导出接口。

该授权仅覆盖工资资料查看和导出，不新增工资修改、责任修改、人员权限管理或其他跨模块权限。

### PERM-WAGE-MONTH-CLOSE-LABEL-001 · 角色显示名称统一

**状态：APPROVED**  
**来源：** 2026-09-09 业务负责人确认数据库正式角色为“工资月结会计”，并指出首页显示“工资资料查看”属于角色显示混乱。

- `wage_month_close_accountant` 的业务显示名称统一为 **“工资月结会计”**；
- 前端不得用“工资资料查看”覆盖数据库/角色目录中的正式角色名称；
- 角色 code 保持 `wage_month_close_accountant` 不变，不新建第二个同义角色。

## 明确不包含的变更

- 本规则**不恢复、不新增**已取消的工资复核、工资调整或其他历史流程；
- 本次只处理工资查看/导出与角色显示一致性；
- Root 既有特殊权限保持不变；
- 其他角色是否可导出工资，不由本规则扩展。

## Acceptance 约束

Acceptance Matrix 对 `wage_month_close_accountant` 至少检查：

1. 真实 Session 角色为 `wage_month_close_accountant`；
2. 必须包含 `wage:view`；
3. 必须包含 `wage:export`；
4. 工资列表 API 可读取；
5. 页面在该角色下显示正式名称“工资月结会计”；
6. 上述检查绑定本文件规则 ID，禁止根据当前 `role_capabilities` 反推标准。
