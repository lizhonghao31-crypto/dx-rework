# P12 整款内外裁与原实裁贯通

- repository: `lizhonghao31-crypto/dx-rework`
- target base: `release/digital-production-v1`，P11合并基线 `c478bebc11360d09b37d4b6cb8487bb2a876eb49`。
- local source: P11冻结候选，含P10最终审查修复。
- working branch: `feat/digital-production-p12-bulk-cutting`
- scope: 稳定PO关联、原实裁整款完成、内外裁权限、补号合同/制单/查询同步。
- allowed: 原裁床/外发编号适配、固定数字任务/产前投影、制单编号投影、migration/manifest、办理页及测试。
- forbidden: 部署/重启、线上数据库/真实订单、新数量台账、修改原Root纠数规则、逐色提前发厂。
- gate class: FULL

## 完成行为

使用原选厂审批中的裁床工序区分本厂裁与外厂裁，新数字单须明确选择；不增加开裁审批按钮。本厂整款24小时保留，外裁由当前主跟单登记且无预设SLA。原裁床照片1—3张、士啤片和实裁的独立含义、旧裁单岗位及Root纠数均保留。

原cutting_orders创建时按外发position→母单lineId建立显式cutting子单映射。某PO保存实裁不完成整款任务；全部PO的原cutting_records齐备后在同一事务内完成唯一任务和一次完成事件。新表仅保存完成身份/时间，不存数量；页面从current_cutting_records读取含Root更正的现值。数量差异单独展示，加裁5%不改母单下单数。原裁床列表/图片授权按新单当前主跟单匹配，旧单范围不改。

母单补号沿用原不可变sourcing_style_revisions及合同版本生成逻辑，原外发补号同时反向同步稳定母单行；仍使用原重复款号检查。有效制单只覆盖编号显示，技术和历史快照不改。按正式号、代用号、原款号别名及当前PO查询原裁单；不重建任务、不重启计时。

## 本地证据

- API/Web类型检查、ESLint、migration manifest校验及Web构建通过（原bundle体积警告仍在）。
- PGlite完整迁移后的外发/数字身份68项通过：内外裁允许/拒绝、两PO局部不放行、全部完成及重试只一事件、补号同步原单/合同/有效制单且taskId/进入/截止不变、Root纠数读取原有效数。
- 全非DB套件1838项通过；381项数据库测试跳过。PGlite不替代真实PG并发证据，真实PG由当前Head Full Gate验证。
- Chromium桌面及390px手机的模拟资料布局检查无脚本错误/横向溢出，外裁隐藏内裁预派，原实裁链接可见。不是线上业务验收。

提交、Gate、Review和合并以实际结果更新；尚未部署。
