# 模块01第三轮 PR01：统一双进度只读投影

## 授权、来源与边界

2026-11-07 最新范围：本轮现在只做 PR01；不并行施工 PR02–05。完成代码和必要检查后停止交用户验收，用户确认后才继续；不沿用之前连续自主合并的授权。部署由用户执行，不改现场配置、真实业务数据或生产。

完整方案 Library `libfile_fde3_f-55334960e7248191b47bca663d0caab9_c8d3bf5d609c8191bce6411a30e94d44` 已完整读取228行；定稿首页、详情、设置三图已实际查看，分别为 `libfile_fde3_f-3a313ed0b0cc8191999ad539ded4ba5f_c8d3bf5d609c8191bce6411a30e94d44`、`libfile_fde3_f-1c7a32bd5de081918e22347fc3763195_c8d3bf5d609c8191bce6411a30e94d44`、`libfile_fde3_f-3de8a1464e6c81918e28f035f430337d_c8d3bf5d609c8191bce6411a30e94d44`；原风格参考 `libfile_fd2077ee57108191a9d44080f41ebb97` 已查看。图片数字不作为业务数据。

实际远端 `release/digital-production-v1` 为 `becb16847ca2f6a0d6a7f5beb783a33cce19c7bc`，包含 #914–#921；工作分支 `m01/r3-p01`。已显式更新远端引用，main 与 release 分别独有97/837提交，不能用 main 替代本次base。风险FULL：共用只读进度及跨页面合同；无迁移、状态机、权限扩张或现场数据修改。

N个案所需当前订单ID、34项完整原接口快照及逐项任务/轮次/继承/特批凭证尚未提供，检索只取得方案和历史体验文档，不能据此推定11项全部应完成。局部待核不阻塞已批准的独立双进度口径。M管理座舱三项截止已由父窗口现场核对，本PR保留原日期映射；额外全节点时间专项暂停。沙盘、自动业务ID生成及其它裁后工作区均不施工。

## 影响记录（实现前）

|批准规则/来源|实际入口|读取与旧消费者|初始化及历史边界|验证预期|
|---|---|---|---|---|
|2026-10-19原话及本轮重申：适用大阶段均分、阶段内有效小节点均分|DigitalJourneyQuery只读投影增加统一visualProgress|首页list及详情read同源；原journeyBusinessProgress、legacy display和工作区计数继续保留|只消费原有效业务要求及其多PO/轮次/替代/特批证据，不把批次当权重；不适用阶段排除，未知不当完成或0|手算不等小节点数、缺失/未知/不适用、源开发、继承与多PO；同版list/read一致|
|自然连续时间与日期来源不混用|统一纯读取函数计算timeRatio|原businessProgress.dates.forecast/actual、当前节点进入时间、统一asOf|预计只取原forecast，不拿采用计划或责任截止顶替；缺可靠瞬时边界就null；不改任何已计算原日期，不编午夜或等待上限|自然跨周日、前/中/后、有界、非法时间、日期精度、原三项日期与快照防回退|
|原权限与历史、编号可信性|原Query授权集合保持|原Postgres读取、当前轮及所选历史轮、前后端合同|不新增查询/写入，不显示UUID或外部ERP请求号；沿用已有identity可信映射，无映射仍null|受限角色、只读事务、现有PG兼容、原业务要求完整性不变|

PR01只交付数据口径和契约；首页/详情定稿布局分别留PR02/03，设置留PR04。自然时间双进度不改变任何业务SLA日历。预计/实际字段分别沿用同名事实，不使用状态完成强制百分比或补造时间。

2026-11-07补充范围：整单和阶段共用同一算法与事实，范围不同不要求百分比、颜色一致。保留 `journey-display.ts` 现行整单状态顺序：取消、原装箱/特批结案、最早客户交期逾期、原客户提醒日临期、已启动、未启动。新投影只复用既有阶段risk，不新增整单risk，不把任一节点逾期自动汇总成整单红色；首页配色仍待后续已批准界面PR按原状态接入。本PR无样式验收声明。

原生回归曾发现：可信reader允许返回scenarioId=null，不能按scenarioId有无辨认是否可信。进一步核对原Acceptance runtime确认：普通未关联场景的读取器会返回null，也应回退至同一SQL快照。最终实现由ContextBusinessClock.read接受可选的内部fallback；Journey独自提供SQL时点，原无参数消费者默认行为不变。上下文assertScope仍优先，实际reader结果不被覆盖。原生SLA10及普通多订单列表均附加断言约束这两个边界。

## 实际结果

首版候选daad6073的本地源码指纹为 `e495080b6c484fccac12bd1ef4b1cee98087bd08dcb38f59a62f885a2c91202a`，被测HEAD为开工base，命令前后源码指纹均相同。2026-11-07 09:42:03–09:44:58 UTC：原preflight 249通过；9个定向单元文件143通过；原business-chain两worker运行Journey与diagnostic原生PG共37通过；单worker独立运行原88单成本回归1通过；以上均0失败、0跳过。类型检查、workspace构建、lint、secret scan退出码均0。该结果不能冒充后续fallback修复版通过。

本地Node22.22.2/npm10.9.9，Node限定CPU2,3；自有带隔离标记的低权限PG16.15限定CPU0,1、2核/2GiB。使用原canonical配置和100秒correctness/hook预算；不是CI硬件或现场等效。无新浏览器矩阵，未重跑旧性能对照，不宣称本PR有现场提速。两库测试schema及其它连接最终均0，精确资源核验记录保留任务私有目录。

独立定点复核覆盖新投影、原要求/日期/阶段risk/整单mainState、list/read/history/导出与可信编号读取链；只增加纯计算，无新增DB查询或写入。已安装可信reader的null场景边界修正后回归通过。普通API之前各次JS默认取时的毫秒差改为同一SQL观察点，受守卫时钟保持原值。

首版远端light42361133166通过，唯一正式GitHub Codex Review覆盖daad6073，summary6705257822及receipt6705277377均无发现。后续fallback增量由执行者单独定点复核并补实际反例，不冒称已正式重审。首版Full42361716959仍在运行，保留原运行，不取消/改写回执；后续修复版须绑定自己的最终head。

普通reader回退反例先在原实现失败：期望SQL固定观察点，实得逐次真实时间；私有日志m01-r3-p01-unscoped-clock-before-fix.log。修复仅增加可选fallback并由Journey传入，不把客户端日期作为时钟，不改变默认调用、既有assertScope、场景后检、安全/审计时间或业务SLA。额外核原时间读取、满池及COMMIT后时钟变更守卫；只更新本diff三个时间文件的候选注记，未恢复全节点时间专项。

修复版源码指纹 `342cfffb6311dd13245d2d9c4a4eb6f34c5cffaa278a961d86eb7f7260afee14`，10:09:38–10:12:47 UTC：preflight249、定向单元157、原Journey/diagnostic PG37、原time-reading-clock PG13、原88单成本1，全部0失败、0跳过；types/build/lint/secret退出码均0。两库最终0测试schema/0其它连接。准确命令、源码前后指纹、日志和结构化结果摘要见当前construction-evidence，首版报告保留不覆盖。clock套件使用原vitest.config.ts的PostgreSQL模式、单worker、文件原100秒配置及既有120秒初始化上限；其它native/cost仍为原business-chain配置。

执行者对正式Review之后的增量复核：只读可选fallback在ContextBusinessClock中放在assertScope和实际reader结果之后，无参数调用仍走原默认；Query只传原SQL快照，不新增查询或公开日期输入。实际反例证明普通无场景读统一asOf，可信null场景时间及原混合场景/满池/COMMIT后冲突仍正确。旧正式Review仅覆盖daad6073，不冒称覆盖修复提交；原协议允许已审祖先与已闭合增量，仍须最终head自己的light及Full。

远端修复版检查尚待完成，不能用旧Full冒充。最终完成后停止交用户验收，不自行合并或开始下一PR。N现场34项及11项凭证保持未证，不将当前TEST反例写成现场结论。
