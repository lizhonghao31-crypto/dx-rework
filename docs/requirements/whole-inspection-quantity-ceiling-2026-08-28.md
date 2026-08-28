# 整查数量上限规则变更（2026-08-28）

状态：业务负责人已确认  
适用模块：尾部返工数字化模块 N02、N04、N05、N06

## 1. 施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: b62c0cbb77878cfa2e025bc593920a7f0ac9cb09
working branch: fix/whole-inspection-quantity-ceiling
task scope: 工序有效数量允许小于或等于整查有效数量，并将业务展示名称“尾查”统一为“整查”
allowed files: apps/api/migrations/0110_whole_inspection_quantity_ceiling.sql；apps/api/src/platform/migration-manifest.json；本规则涉及的 apps/api/src/rework、apps/api/src/access、apps/web/src、packages/contracts/src 业务文案与数量校验文件；对应 tests/unit 文件；本需求记录
forbidden files: 既有 0001–0109 migrations；CSS、设计 token 和页面布局；内部 tail_inspection 标识、数据库字段和历史审计事实；其他业务模块与依赖
```

执行方式：工作区没有仓库副本，ChatGPT 控制器依据 GitHub 当前 main 精确 SHA 直接施工并通过 GitHub Actions 取证。  
门禁：Quick Gate + Full Gate；Full Gate 全绿后由业务负责人手动触发一次 Codex Review。

## 2. 业务规则

对每一道普通返工工序独立校验：

```text
0 < 工序有效数量 ≤ 整查有效数量
```

- 工序数量小于整查数量：允许进入 N05 并提交 N06。
- 工序数量等于整查数量：允许进入 N05 并提交 N06。
- 工序数量大于整查数量：拦截并要求调整报数。
- 工序或整查缺少有效报数、有效数量为零：拦截。
- 多道工序分别与同一个整查有效总数比较，不把不同工序相加。
- 最终确认数量取各工序自身的有效数量，不取整查数量。
- 明确标记为“无需整查”的订单继续使用既有无整查规则。

## 3. 名称与兼容

- 所有当前业务界面、提示、待办和权限展示统一使用“整查”。
- 新建或重新保存的特殊工序固定存储为“整查”。
- 兼容历史客户端仍提交“尾查”的请求，但统一规范为“整查”后写入。
- 既有订单、历史迁移和审计记录不做批量改写。
- 内部 `tail_inspection`、数据库表字段、权限代码和接口字段保持不变。
- “尾部主管”“尾部最终数量确认”属于岗位和节点名称，不在改名范围。

## 4. UI 边界

- 不改变页面布局、CSS、调色盘、组件结构和既有入口。
- N05 状态由“一致/不一致”调整为“可确认/待报数/工序超数”。
- 原“差异”位置显示“整查余量”，计算为整查数量减工序数量。
