# R3 DEF008：站内通知自身授权订单身份

## 施工预检与边界

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1（本轮用户明确授权）
- base SHA: 130a58e7a1910e445d2de1e6510e911329f5add8
- working branch: fix/r3-notification-task-identity
- task scope: 让可办理的个人站内通知携带其自身已授权对象的最小款号身份。
- allowed files: notification-service.ts、对应通知回归、完整业务链内的精确 case 范围回归 helper、本证据文档。
- forbidden files: 全局 access-policy、业务角色/capability 配置、数据库迁移、部署工具、依赖、首页。
- gate class: FULL（通知关键路由与字段权限边界）。
- main 只读基线：2d4cf6ba183a0f1ce5ac04e5ddfeb60a617479b8。

## 已确认根因

父浏览器执行者在 a8e605ad Acceptance 上，以工厂应付会计实际复现 UAT315：背景页为 TEST-PR0506，通用超时通知实际跳向自己有权办理的 TEST-FIX02-PS-BLUE 子单，但通知没有自身款号。背景页与跳转目标不同是允许的；缺陷是通知缺少目标身份，并非错跳或错账。

原渲染只给有母单 technical 阅读权限的人投影 context。有个人待办、角色和 capability 不等于有母单权限，也不能单独证明对子单有阅读权限。新逻辑保留母单策略，校验业务实体与原 route 相同，再调用既有 sourcing / production / rework 阅读服务校验该精确对象。拒绝 403/404，非活动母单及取消返工不投影。只有已授权子款号会成为 context；orderId=null，PO 和颜色数组为空，不投影私有附件、预算、金额、供应商或其它 PO。

自己有实际 execute 权限的数字生产任务沿用既有 task 授权，补充该任务已绑定母单的款号。尾查指派、厂内审批、外部责任 case 与责任认定这四类既有返工实体，先通过原表查到实际 rework_order_id，再校验与 route 的返工目标相同；缺实体或错绑拒绝。上游缺主办异常与 information 通知继续沿用原过滤。开发文员和打版员工的已有授权及拒绝逻辑保持。

## 验证范围与证据等级

子阅读的三个既有只读入口使用当前 query/事务 client，不能在 claim 持有连接时再次借用连接池。单连接原生回归在补丁前明确失败于二次 pool.query；修复后同一 max=1 条件下可正常取得款号并确认待办。该检查也防止并发 claim 占满连接池时互相等待，不改变其它子模块服务写入行为。

| 角色 / route | 最小身份与原对象 | 能进入目标 | 确认提示≠业务完成 | 越权拒绝 | 证据等级 |
| --- | --- | --- | --- | --- | --- |
| 工厂应付会计 / sourcing_detail | 新待办、超时均为各自子款号；两单队列不借用背景页；错绑拒绝 | 既有 SourcingService.getCase 实际通过 | 原 TodoResponse（含状态、时钟）确认前后相同 | 外人、缺 capability、失角色、母单 technical/budget、兄弟 PO、information、暂停 | 完整 schema 的原生隔离 PostgreSQL 回归；父仅提供旧版真实 UAT，修复尚未部署 |
| 非主跟单 / digital_production_task | 自己 production_sheet 的款号 | 实际 task.read 和 execute 通过 | 原 task.read 确认前后相同 | 外人、母单 technical/budget、暂停及完成后提示 | 新增原生回归，静态候选被独立复现；未声称线上复现 |
| 开发文员 / 三类 development 任务 | 既有 source 款号 | 实际 task.read/execute | 原任务不变 | 外人、母单 source technical、暂停和完成 | 保留原有原生回归 |
| 打版员工 / pattern_room_order | 仅自身款号 | PatternOrderReader 对本人通过、外人 404 | 原待办保持 pending | 外人收件残留、取消子单、失 capability、停用账号、暂停 source | 保留原有原生回归 |
| production_detail | exact child reader 返回的 firstStyleNo；不带母单/价格 | 必须委托 SourcingProductionService.get，403/404 拒绝 | 只写 receipt | 错绑、子阅读拒绝 | 组件委托回归；生产动态待办原已有身份，不列为新实机缺陷 |
| rework_detail / process_configuration / whole_order_review / responsibility_detail / own_factory_approval | exact child reader 返回的 styleNo；绑定 reworkOrderId 必须相同 | 必须委托 ReworkBusinessDetailService.get | 只写 receipt | 错绑子单、取消返工、子阅读拒绝 | 组件委托回归；不替代修复部署后的多角色 UAT |

返工四类子实体的关联回归覆盖相同返工、其它返工与不存在的实体。原生新增尾查指派例：当前实际 worker 角色与 tail_inspection:report capability 有效，原表指派和待办均存在，但既有 ReworkBusinessDetailService 对该 legacy 指派目标拒绝403；通知、剩余数量及展示后的重新阅读同样拒绝，业务待办仍pending。没有赋予 legacy 指派额外阅读权限，也没有用旧 tail_inspector 角色恢复权限。该例说明“收件人+角色+capability”仍不能证明目标可读。

原生测试只运行本轮拥有的 PG16 容器及独立 schema，测试用户为非超级用户。角色/人员 fixture 初始化和角色失效模拟只对其测试 schema 短暂关闭指定 fixture 触发器并恢复，通知实际授权、阅读服务、状态检查不被 mock。超时通过临时恢复式 Date.now 时钟推进，未改实际业务日期或数据库。

旧版 130a58e 原样替换 notification-service 的失败对照：新增会计与非主跟单两例均在 context 应有款号处失败（实际 undefined）；恢复候选后通过。

本地检查：初版通知完整 schema 13/13、通知与完整业务链三组76/76、普通测试423文件2126通过（60文件510环境相关测试跳过），lint/typecheck/build/migration lint/secret scan通过。补返工子实体后通知完整schema14/14、子阅读/关联委托14/14；最终三组原生77/77、lint/typecheck/build（postbuild静态链77/77）、secret scan及diff check均通过。当前 Head 的远端 FULL Gate 和一次 Codex Review 另以 PR 记录为准。

sample_detail / supplier_onboarding / wage_period_detail 不映射数字母单，legacy 入口不在本 PR 范围。DingTalk delivery-worker 部分类别身份缺失是独立静态风险；数字子单已有 enqueue/delivery 双抑制，本 PR 不改外部发送，不宣称已修该风险。

没有部署、真实订单写入、ECS、服务重启、权限扩大或 homepage 变更。合并后仍需用户部署候选，由唯一浏览器执行者复测 UAT315 及相关允许/拒绝路径。

## 唯一 Review 的 P1 收口

Review 对 5724a154 提出 discussion_r4226390830：同一返工有加工厂和面料责任 case，父返工可读不等于精确 case 可读。实际 case 入口使用 `external_responsibility_can_view_case`，必须调用既有 `ExternalResponsibilityService.getCase` 验证 route.entityId，再核对返回的 reworkOrderId；母单 technical 阅读不能绕过这一步。原实体为 case 时还要求 entity_id 与 route.entityId 相同。批次分配的既有 tab=external_responsibility 路由使用原 batch reader，并校验实际活动 batchId 与父返工，不能把 batch UUID 当 case。全部查询沿用当前事务连接，读取结果中的金额、供应商、快照不进入通知。

新增 5 项组件回归覆盖 exact case 允许、跨父错绑、兄弟 case 403（母单可读/不可读两种）、原 case 实体错绑、合法/其它/缺失分配 batch。完整 N01–N11 原生业务链生成的实际加工厂/面料 case 和持久化角色还验证：两个应付角色都可读父返工，各自 case 可读而另一类 case 403；各自通知只带 UAT-FULL-CHAIN 款号，跨职责通知隐藏；确认提示保持业务待办 pending，未泄露母单、供应商或金额。case 阅读与通知授权没有 mock。通知 fixture 只在 owned schema 中生成，并仅为 current/ack 测试设置自身 receipt cursor；关联放在原 legacy 钉钉断言之后，以保留已确认的数字子单外部发送抑制行为。

将 notification-service 原样恢复到 Review 的 5724a154 后，新增原生交叉拒绝与两种母单条件的拒绝回归均明确失败（3 项）；恢复修复后定向 20 项全部通过。仍只有一次主动 Review；最终修复 Head 的 FULL Gate 另以 PR 记录为准。

P1 修复后本地完整通知、完整 N01–N11、原外发原生业务链与组件委托合计 160/160 通过；lint/typecheck/build（静态业务链 77/77）、secret scan 与 diff check 通过。未修改全局权限、schema、部署工具或依赖。
