# 收货关联与生产风险提醒分离

用户2026-11-15经Dot授权：正常收货不再依赖供应商试点；原设置改为“生产风险提醒设置”，迁至管理设置对应区域直接展示和操作，沿既有UI与Root权限。目标release/digital-production-v1，实际base768306759f9687fd93dd7227c8e269ad8572cf37，分支fix/receiving-without-production-pilot，Full；每PR初始Light一次，正常Review/Full，允许合并，不部署、不改现场数据。

影响闭环：production-closure-service.expected、linkReceiptByCuttingOrder、linkReceipt，以及0236最后覆盖的guard_sourcing_production_receipt_link原来均依赖pilot。新增0291替换当前守卫，API三个入口同步去依赖；仍校验已发货、未排除、同源款号和正数PO份额、实际工厂、收货日期和原收货审计。原FOR SHARE OF pilot转为锁定实际shipment，开关变化不改变收货事实。无历史回填、无旧迁移修改；manifest和Acceptance函数owner清单绑定新SQL哈希。

全局盘点：pilotFacts继续按已启用的实际执行工厂投影数量风险；setPilot仍仅Root可用，关闭继续解除风险提醒。历史表/API名称及旧值保留兼容。receipts及receiptSummary本来不依赖开关，继续读取原关系；洗水关联仍要求同生产订单、工厂、PO和真实收货版本，不猜工厂。旧未关联实收不会自动出现或被重复登记。

UI：移除实时生产看板管理区的旧设置组件，原排除控制保留；CockpitProductionSettings依真实session Root显示生产风险提醒页签，直接呈现供应商开关，无中转页/折叠按钮。沿r5面板、按钮、表单和颜色，1165px及窄列允许名称换行；非Root无入口，服务仍独立拒绝读取/写入。原风险设置语义不扩大为新的提醒规则。

验证：production-closure-postgres覆盖试点无记录/关闭/开启、并发开关、自动与直接关联、幂等重放、未发货不关联、历史不回填、款号修改/排除及原风险范围；factory-logistics-cockpit-postgres验证同裁单转厂两厂同时发货须明确工厂、错误工厂拒绝、原厂与新厂收货摘要隔离；bulk-washing-postgres复验真实收货关联覆盖及质检更正数量约束。r5-settings-native-browser-postgres用完整原App/真实认证操作Root提醒设置、刷新核持久值，PMC原页无入口且API403，保留原设置/演算/客户及键盘办理。初始新增用例的候选搜索、warehouse能力、cuttingOrderId、原实裁前置等初始化遗漏已按既有入口补齐，不改产品守卫以迎合测试。

后续Acceptance观察另列，未纳入本PR施工：洗水真实返工复检身份及累计数量；已发布预算后的洗水费用补录/费用引用入口；洗水岗位有权子区与无权factory父区错误/加载；独立开发样板日期选填被拦；完成后附件脏提示及日期型实际完成页头。不得把已读源码或录错撤销当这些现场全链通过。

实际定向结果：95/95单测；原风险/回货20、分厂与时效读取14、洗水7、原App设置8，共49/49。最后只改收货测试的独立数据后重跑该20项，其他三组运行输入未变、复用原通过结果；组合报告明确标注来源且保留原失败记录，不把旧运行冒充全通过。真实页面截图production-risk-settings-1165.png已打开检查，直接表单与现有设置风格一致、无二次入口。API/Web类型及受影响ESLint通过，迁移静态/维护清单与263个CI协议测试通过。待远端一次Light、正常Review及Full，未部署、未现场验收。
