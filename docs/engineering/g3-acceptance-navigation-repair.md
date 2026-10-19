# Acceptance 搜索兼容性与记录入口修复

缺陷来自实际验收 release `6b1644f3d55394dc5ed0b01bdc0839421f3f5b56`；本修复基于已独立合入外发UI #813的release `52f52070be105ec144978c0d3d0ffc9f23b540e8`。验收方发现开发单第2轮出现两个完全相同链接，外发也有两个无版本同目标入口；三条 IE／管理／老板历史入口各有不同 entryId，应保留。财务异常中一条“待办逾期：财务核对”的返工单为空，链接退化到返工通用列表，却被称为原记录。真实该条待办的 route_descriptor 未读取，不能宣称已在线核销。

开发单记录会把文档版本与开发轮次分别写入 version，但使用相同 development+round URL；外发关联又会因 lineId 有无生成不同记录身份。仅将 development/sourcing 展示入口按实际目标聚合，原节点事实、PO关联及进度不改；不同轮次、历史 entryId 和节点仍分别保留，任务办理与只读原模式保留。

异常查询同时读取待办原 route_descriptor，经现有严格契约校验后，仅为 sourcing_detail 使用共享 todoDestination 恢复外发精确入口，不推断新业务ID或新增路由。原扣款 case／settlement_followup 不变。报表宿主拒绝把通用 `/ui/tasks` 列表称为原记录；无法解析或当前尚未支持精确入口的项目显示“记录不可用”。目标页继续执行原权限，无新增授权。

验证包含同URL不同文档版本／轮次元数据、同外发地址不同PO元数据、三个不同历史入口、任务模式、外发精确链接、无效和通用链接拒绝；完整迁移的隔离 TEST 数据库中按合法 todo.create 审计上下文创建合成逾期财务待办，使用真实异常查询核对中文筛选与原路由；浏览器在1440／1180／390验证驾驶舱及报表共6场景，无外部请求或业务写入。各检查结果以同目录外的本轮证据报告为准。

独立于外发视觉 PR。搜索500只在隔离PG13按下述证据修复，不改数据库权限、迁移、状态或业务数据，不部署。

既有report-exception-captions-postgres轻量SQL夹具同步增加可空route_descriptor，并为原INSERT显式列出字段。原三项回归与下述两份套件合跑，在PG13/16各14项通过；覆盖全部显示类别、未知类别、筛选/范围/绑定文本及扣款case精确入口。未以无数据库时的跳过代替执行。


搜索500另已在相同release编译HTTP/test链路、完整迁移和非所有者只读角色下用PG13.23复现：空搜索200，所有非空搜索500，底层42601定位to_jsonb(todo_view)后省略AS的value别名。PG16.14同样7条HTTP通过。最小修正仅增加显式AS，不改变别名、授权、匹配、计数、排序或分页。保留原有todo-global-search-postgres数据库回归，并在完整迁移的digital-my-todo-context-postgres套件补真实buildApp/TodoService/响应校验的7条HTTP请求，覆盖Root无module、普通角色suppliers、中文搜索、清空和无结果；同一套件在PG13及PG16执行。无需先改变Acceptance日志配置或重启。日志关闭是已确认的诊断缺口，与本次SQL语法根因分开，不将其混称为根因。线上仍需用户更新后复核，隔离复现不等于已在线核销。
