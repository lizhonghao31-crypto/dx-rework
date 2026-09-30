# A1 页面业务验收记录（2026-09-30）

## 版本、范围与状态

- 已部署并复测的候选：`0b748a82ea8e2972154b0a6ce4156d297c895857`（#595），schema `0221_digital_production_notifications`。
- 本轮按业务负责人要求验收当前页面的实际业务操作，未运行角色权限矩阵。
- 已发现缺陷的最后一项是新建母单后主跟单下拉框未回显。本PR修正该表单；候选更新后仍需在Acceptance验证新建、重开及切换订单。
- 当前结论为部分通过；任务引擎及完整业务链路不得标记为已完成验收。

## 已执行的页面场景

| 场景 | 页面操作及结果 |
|---|---|
| 日期与默认跟单 | 新建 `TEST-A1-R595-DATE-001`，下单日2026-09-30、合同交付日2026-12-31保存并重开正确；继承BO-IP的[UAT]订单跟单 |
| 重复颜色 | `Blue` 与 ` blue ` 被明确提示“同一母单颜色不能重复”；改为Green后成功保存两款色 |
| 数量展示 | Blue的M码5001显示为5,001，Green的L码2保存正确 |
| 重复尺码及零数量 | `TEST-A1-R595-SIZE-002` 的重复M码被明确拒绝；数量0被表单阻止；改为M10、L3后保存成功 |
| 无默认跟单客户 | FL订单保存后显示待指派；下单日2026-02-28保存正确、未填合同交付日显示待补 |
| 编号与搜索 | 补PO `TEST-A1-R595-PO-002` 和正式款号 `TEST-A1-R595-ST-002` 后保存及重开正确；PO搜索、无匹配及清空搜索正常 |
| 客户默认跟单回显 | BO-IP、FL与BO-IP之间切换，已保存的默认跟单和未配置值对应正确 |
| 正常来源到下单 | 在窗口新建 `TEST-A1-UI-FLOW-003` 头版来源，客户PD；点击确认下单，保存PO `TEST-A1-UI-PO-003`、测试黑M码5件；母单显示已关联开发来源 |
| 我的待办恢复 | 修复Acceptance数据库视图依赖授权后，窗口模块切换、搜索、清空搜索和重新载入均正常，不再500 |

## 主跟单回显缺陷

新建BO-IP母单时业务文本正确显示已继承默认主跟单，但“调整主跟单”下拉框显示“请选择”；重开订单后才正确。该框使用 `defaultValue`，首次渲染时异步人员选项尚未到齐。本PR使用受控值，并按母单ID和已保存的主跟单ID同步状态；候选人员加载及切换订单会显示相应保存值。

API接口、预期版本和后端授权条件沿用原实现。当前修复尚需部署后的窗口复测，不能用本地检查或Gate替代。

## 待办500的实际原因及修复

原待办与合并列表的只读诊断报42501；数字生产与实时生产提供方正常。API和维护连接的端口、数据库OID及视图OID已核对一致。

`current_sourcing_cases` 的所有者为 `dx_rework_acceptance`，默认按其权限读取依赖关系；仅给运行角色授权未修复全部链路。嵌套视图读取通过后，确认该所有者还缺少 `sourcing_style_revisions` 的SELECT。按两个视图的实际关系依赖补齐缺失读取权限后，六个列表/计数诊断均PASS，任务总数为0。修复范围仅为独立Acceptance数据库，不是业务角色权限变更。

#595的UUID兼容处理不能被记录为本次500的已证实根因修复；数据库授权诊断才提供了实际证据。详情写入Acceptance唯一操作手册。

## 未执行、未交付及A2补测

正常创建来源及确认下单不会替代开发单发布。当前P01—P04提供任务基础能力和办理页面；开发单表单、发布动作和按真实业务条件生成任务安排在P05以后。

新建 `TEST-A1-UI-FLOW-003` 后手动刷新仍显示“暂无任务”，页面尚无发布开发单入口。之前提供的任务fixture命令未完成创建；该脚本路径已停止，不把人工准备的引擎样例算作从头到尾页面业务验收。

A2（P05—P08）接入真实业务入口后补测：任务生成与主办待办、前置到齐才开始计时、完成与交接、后继解锁、阻断/解除、暂停/恢复、时间核实及历史、提醒去重与跳转。该批次未测项保留为pending，不为进入A2伪造A1全通过。

## 业务规则约束

本PR未改任何SLA。车板正常24小时、板房尾查4小时保持；只有中转、寄样、预算、制单、质检、仓库发出留待以后设置，其余既已确认的值继续保持。

## 本次修复预检

```text
repository: lizhonghao31-crypto/dx-rework
main SHA: 06f4f753ba4361d4cad20d7d30311cbf4a27126c
authorized integration base: release/digital-production-v1
base SHA: 0b748a82ea8e2972154b0a6ce4156d297c895857
working branch: fix/a1-merchandiser-recall-20260930
task scope: close the observed merchandiser form recall defect and record actual A1 evidence
allowed files: apps/web/src/digital-production-access-panel.tsx; docs/operations/acceptance-lab-runbook-v1.0.md; this record
forbidden changes: API auth/roles, schema/migrations, task/SLA rules, production configuration
gate class: FULL
```
