# 工资权限增量 · 2026-09-09

### PERM-WAGE-MONTH-CLOSE-EXPORT-001 · 工资月结会计导出工资

**状态：APPROVED**  
**来源：** 2026-09-09 业务负责人明确确认

`wage_month_close_accountant`：

- 保持现有 `wage:view`；
- 必须拥有 `wage:export`，可使用现有“导出当前工资明细”功能；
- 业务显示名称统一为“工资月结会计”；
- 不新增工资修改、月结流程、其他模块或人员权限。

Acceptance/回归只验证上述范围，不从当前数据库反推标准。
