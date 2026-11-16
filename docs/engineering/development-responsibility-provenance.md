# 开发责任起点可信度与原核实闭环

用户经Dot授权按逐PR持续修复。目标release/digital-production-v1，实际新基线47d08674f937bf5b385fd42cecea6dd4b9cdcb63（#1005已核准确Full/Final/merge tree），分支fix/development-responsibility-evidence。本PR按FULL、每PR唯一Light、正常Review及准确Full后合并；不部署、不改真实业务数据或真人权限。

已证现场source9fc40b51：内洗补报未核实A22:53:30.123，唯一尾查自动ready亦未核实，无独立可信交接；首修订却回填系统R22:54:18.382／D23:24:18.382，座舱显示按时完成。v27§6.1及用户经Dot明确：可信起点不足为责任待核，保留尾查真实完成。代码链为原生explicit null通过??回退自动办理时间、旧developmentSlaEvidence不核起点quality、orderTimeReading优先previous而再次恢复R。不能只隐藏提示、统一从允许办理计时或改变公司／本单标准。

范围：统一源任务责任起点的可信证据选择，保留各节点已批准来源、真实完成、原目标和真正已开始窗口；旧修订可审计，未知不得借系统时刻或旧快照判按时，核实后沿原入口恢复精确真实时间与适用窗口。关联源/轮次/任务不可串用，依赖未核实不能充当独立人工交接。原时间核实表单同时支持正常分钟和秒/毫秒及明确填入原记录值（不自动提交，不把补报称为已核实），覆盖source777dc92e原纸样22:40:28.850→未知→准确恢复。保护原授权、原因、过去时间、脏页与未知提交边界，不造新审批/面板/第四套业务时间。

必要验证将记录实际结果：显式未知与旧R回填反例；保留已知A和原计划偏差；可信已开始8小时不被后来4小时覆盖；未核实依赖／独立可信核实的区别；原生内洗尾查及核实历史、原页面秒毫秒操作、权限拒绝；旧单／新fixed及可重建投影，查询预算与快照。无证实的其他双取时／取消原raw timing观察不扩为本PR时钟修改。新PACKSTOP未知提交先核实际部署版本／请求阶段，不重发，另列后续核查。

实现入口：`order-time-native-timing.ts#orderTimeNativeTiming`保留原生显式null，拒绝将其回退为激活时刻；原ready核实在`task-service.ts#correctTime`沿原授权、原命令和审计写入，真实已开始额度保留。新增纯读取`development-responsibility-window.ts`分别验证当前原核实、冻结依据指向的同任务组织就绪、可信本来源前序及旧无quality元数据；SQL证明只在原授权task读取中取精确引用，不对外返回证明对象。原核实匹配当前任务生效R/quality，避免并发事务登记起点排序替代真实最后写入。PO级ready不被当作整任务核实。

旧消费者：`development-sla-evidence`不再从无可信R的修订生成自身截止；`order-time-reading`只用当前精确任务证据替换责任起点，继续复用原完成／日期映射、完成时目标历史及批次逻辑。`task-service.read`、`journey-task-summary`统一责任质量及R/D，保留实际完成、计划和原权限。组织就绪先于办理的车板／工艺读取额外核原enrollment、同task事件及readiness／craft-step精确引用，不借兄弟、其它轮次或后来的办理事件。可重建事实模型版本从v6升v7，沿原失效／队列路径刷新旧派生结论；无新schema和业务回填。

原页面`digital-production-tasks-panel`两处实际时间控件支持step=0.001，核实表单提供明确填入原记录，不自动保存；普通分钟、原原因、过去时间及授权不变。Chromium可将输入字符串.850规范成.85，数据库ISO仍必须准确为.850；测试比较实际时刻，不以字符串显示或容差代替精度。正常表单保存后的父级重新读取可能卸载／折叠原记录区，原浏览器回归等待新记录到达后从正常summary重新展开，不用DOM绕过。

实证边界：PACKSTOP source6258f86d及request9d6ca68fd9d2b48eea07e1f428cf4ae1仍无实际失败路径／部署SHA证据。当前合并源码有preparing（建档／草稿保存）、publish_check、publish、confirm_check、confirm阶段；只有实际发布／确认命令结果不明才保留其恢复区，较早独立保存或读取失败不能据文案反推已发送publish。#998/#1001修复并不证明旧Acceptance资源已经更新。原页面和命令不刷新、不重发；本PR不夹带该未归因问题的猜测修复。

验证经历如实保留：初始三项红例证明显式null／旧窗口／legacy优先回填；扩展全单测3781通过、1个严格SQL mock未识别新增投影列，原40项PMC权限断言不变，窄识别新查询后定向通过。真实PG原始准备阶段先暴露辅助fixture漏传scenario、历史服务返回Date与API字符串的区别、正常父级重读后的折叠时序和Chromium小数规范化；修正准备，不改业务守卫。后续扩展发现车板已有真实组织就绪、尚待执行交接时不能清空R，补精确原事件读取后，原多工艺三条链恢复通过。之前50项含88单真实性／成本回归通过，physicalSQL7074≤原7100；该日志是当时组合，不冒充最终候选CI。最终结果以本PR现有construction-evidence、原报告及精确Head Full为准。

本地资源：使用锁定Node22.22.2/npm10.9.9及同lock第三方依赖、独立workspace包构建，不声称fresh npm ci。PG16标记隔离库、非超级用户／无BYPASSRLS，单PG worker；单测最多2worker，最终定向1worker。原临时容器及schema按manifest清理。为根文件系统空间，已合并PR02干净verify工作区的忽略node_modules可逆迁移至/tmp并保留原路径符号链接与workspace链接，未清理源码、证据、业务数据或备份。
