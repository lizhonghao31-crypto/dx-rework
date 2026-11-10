# R5-01 有效质量、装箱与交付

基线：`release/digital-production-v1@45fc58a572437aa45318d3e91ca18631e3fa03b2`。
分支：`fix/r5-01-qualified-packing-20261110`；最终等级：FULL。
依据：已批准完整v2方案§9/§11/§15及九PR执行表R5-01；本项不启用新的订单时效流程。

两笔有效收货各2件，质检合格1+2件，原装箱4件时，旧`packingSlaEvidence`仍返回业务已完成。新增反例先实测失败。现在保留原装箱4件，但有效交付待核，不推定已交3件；原结案未清事项、装箱事实、座舱最小事实、日历和当前统计一致采用该结果。有效更正/重检后只更新相关对象，旧数据不会冒充最新；真实0不变。

`packing-quality-coverage.ts`只批量读取已授权订单的原生数量和当前数量版本的质检，不装配全订单Journey/SLA。日历原累计与有效交付分字段；查询结果规则版本更新拒绝旧算法快照冒充新结果。Journey计算版本更新沿原有界启动登记及worker，不在GET重建全库。原生产统计RR、当前15条富化、完整统计/导出和所有写入权限保持。

工厂检查历史按原生产/决策身份显示该次工厂，零份额历史可读但不进入当前检查要求；未匹配来源不拿当前工厂填补。没有定稿视觉改造，也未操作现场数据。

相关消费者：原质量/数量更正与差异入口、OrderClosureService、packingSlaEvidence、receivingSummary、journeyBusinessQuantities/JourneyFactRepository、DeliveryCalendarQuery（含标量欠交汇总）、ProductionStatisticsQuery及工厂QC历史。日历原超交夹具补真实追加收货和质检后继续验证超交，不以不存在的成衣假装有效出货。

验证用本地隔离PostgreSQL13.23、低权限角色及原生TEST夹具；Node22.22.2。最初新增样本误用再次初次收货，现改为原多次收货入口，未放宽守卫。初始测试库默认锁槽不足造成清理失败，已仅调整自建隔离实例参数；失败记录保留，不能称首轮通过。最终结果以本PR的construction-evidence及原始报告为准。

本项不对历史业务数或文件做自动修复；追加收货旧异常只有本次已验证的合法路径，不宣称穷尽现场旧反例。未部署、未做现场Acceptance验收。
