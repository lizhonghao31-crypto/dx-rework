# 母单 V2.2 PR01：PO 身份与双交期底座

权威正文为 Library `libfile_45be1ec57b648191b5d60ab604a1589a`《旧母单综合页撤除、PO 身份及双交期治理｜详细施工订单 V2.2》，完整读取 58 页、§0–16。用户已授权本轮六 PR 全程接手，覆盖正文编写时“尚未开工”的状态。本 PR 仅实现 §6 底座，不进入合同 PDF、创建页整体改造、主跟单交接、数字代理移除或旧路由撤除。

用户最终决定：正式 PO 与正式款号是同一业务值，同母单非空正式 PO 唯一，一 PO 一颜色；加工厂交货日不能晚于客户仓到货日，前后端须拒绝；同款按最早 PO 交期预警，不另造未分 PO 实绩提示；当前主跟单申请客户改期、供应链总监审批；Root 原有特权保留，财务核对后的工厂合同交期永久锁定。

## 单一身份与兼容

新增输入 `formalPoNo`，legacy `poNumber/formalStyleNo` 保留为兼容适配。新创建或补号只接受一致的非空值，按既有 `normalize_sourcing_style_key` 的 trim、ASCII 大小写规则判重；落库两个旧字段使用同一值。空正式号及独立代用号继续合法，不施加全系统唯一约束，保留原颜色唯一约束。

新 SQL guard 为 prospective：历史冲突不会被迁移覆盖；读 DTO 对冲突返回 `formalPoNo=null, poIdentityConflict=true` 并保留两个旧值。`production_order_id/source_id/line_id/childlinks`、尺码、数量、历史创建时间和业务事实不重建。新的可选输入不向旧请求自动添加字段，旧幂等 payload hash 不变。

## 独立的当前有效日期

每行分别存客户仓到货日、加工厂交货日、各自版本和来源；`digital_po_date_changes` 追加 old/new、版本、原因、审批/创建 audit、操作者和 requestId。当前值必须有同事务生效的匹配事实，事实不可 UPDATE、DELETE 或 TRUNCATE，不能留下已提交但尚未生效的变更。变更锁原母单及明确行，工厂变更先锁对应原外发单，与合同和财务写入一致。

内部 `DigitalPoDateRepository` 只由真实业务事务适配调用，没有通用 HTTP 日期写入口。创建只登记显式输入的逐 PO 客户日；客户变更和工厂变更各自要求对应原审批 action 及精确 lineId/dateKind/oldDate/newDate/expectedVersion。审批重试不重写后来的当前值；过期版本、跨身份和晚于客户日的工厂日期拒绝。工厂日期在原外发任何财务核对事实出现后永久锁定，Root 也不能绕过；客户日期仍是独立承诺。

新逐 PO 字段是后续新版消费权威值。旧 `delivery_date` 保留原记录，DTO 的旧 `deliveryDate` 对旧读者提供显式兼容值；来源 `legacy_unregistered` 不表示已确认。旧母单或外发整单日期不静默复制为逐 PO 生效值，也不反向更新冻结合同、发布、回签、首次 48h、历史节点时钟或实绩。后续 PR02/03 必须通过各自真实申请审批链产生有效审计，再调用适配器。

## 历史只读报告和迁移协调

`scripts/digital-po-history-report.sql` 自带只读、可重复读事务与回滚，逐项报告：编号别名冲突、正式 PO 重复、颜色重复、客户日期未逐 PO 登记、工厂日期未登记或手工合同来源、已有流程/合同/财务/派单/开裁/回货足迹、缺失 child 行映射、无来源母单、仍有效旧数字代理。报告只列证据和待核对项，不选择一个未知 PO 或猜运输天数。本轮仅在独立 TEST fixture 执行，未读取或修复正式数据。

本 PR 追加 `0237_digital_po_identity_dates` 和真实 checksum、必要维护权限清单。为用户要求 main 工艺 PR 与 release 以后安全切换，仅定点同步同 hash 的 `0223_sourcing_factory_change_craft_names`、显式 main extension 及其精确 pair 规则；没有整支合 main，没有重命名或修改历史 SQL、checksum、applied_at。第三 fork、漂移、遗漏历史继续拒绝。权限清单/校验内核变化不加自动 refresh 豁免，最终工具仍须用户按原审计安装流程更新。

## 交付边界

本 PR 无前端布局变更，视觉截图不适用；不能把它称为母单 UI 已完成。后续五 PR 继续固定分界：创建及客户交期、外发及工厂合同交期、看板双日期消费、主跟单交接与数字代理退场、旧综合首页撤除。测试和 PR/Review/合入状态以当前 HEAD 证据为准；正式多人验收及部署由用户负责。
