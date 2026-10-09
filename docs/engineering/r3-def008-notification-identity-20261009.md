# R3 DEF008：站内通知自身授权订单身份

## 施工预检与边界

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1（本轮用户明确授权）
- base SHA: 130a58e7a1910e445d2de1e6510e911329f5add8
- working branch: fix/r3-notification-task-identity
- task scope: 让可办理的个人站内通知携带其自身已授权对象的最小款号身份。
- allowed files: notification-service.ts、对应通知回归、本证据文档。
- forbidden files: 全局 access-policy、业务角色/capability 配置、数据库迁移、部署工具、依赖、首页。
- gate class: FULL（通知关键路由与字段权限边界）。
- main 只读基线：2d4cf6ba183a0f1ce5ac04e5ddfeb60a617479b8。

## 已确认根因

父浏览器执行者在 a8e605ad Acceptance 上，以工厂应付会计实际复现 UAT315：背景页为 TEST-PR0506，通用超时通知实际跳向自己有权办理的 TEST-FIX02-PS-BLUE 子单，但通知没有自身款号。背景页与跳转目标不同是允许的；缺陷是通知缺少目标身份，并非错跳或错账。

原渲染只给有母单 technical 阅读权限的人投影 context。有个人待办、角色和 capability 不等于有母单权限，也不能单独证明对子单有阅读权限。新逻辑保留母单策略，校验业务实体与原 route 相同，再调用既有 sourcing / production / rework 阅读服务校验该精确对象。拒绝 403/404，非活动母单及取消返工不投影。只有已授权子款号会成为 context；orderId=null，PO 和颜色数组为空，不投影私有附件、预算、金额、供应商或其它 PO。

自己有实际 execute 权限的数字生产任务沿用既有 task 授权，补充该任务已绑定母单的款号。上游缺主办异常与 information 通知继续沿用原过滤。开发文员和打版员工的已有授权及拒绝逻辑保持。

## 验证范围与证据等级

| 角色 / route | 最小身份与原对象 | 能进入目标 | 确认提示≠业务完成 | 越权拒绝 | 证据等级 |
| --- | --- | --- | --- | --- | --- |
| 工厂应付会计 / sourcing_detail | 新待办、超时均为各自子款号；两单队列不借用背景页；错绑拒绝 | 既有 SourcingService.getCase 实际通过 | 原 TodoResponse（含状态、时钟）确认前后相同 | 外人、缺 capability、失角色、母单 technical/budget、兄弟 PO、information、暂停 | 完整 schema 的原生隔离 PostgreSQL 回归；父仅提供旧版真实 UAT，修复尚未部署 |
| 非主跟单 / digital_production_task | 自己 production_sheet 的款号 | 实际 task.read 和 execute 通过 | 原 task.read 确认前后相同 | 外人、母单 technical/budget、暂停及完成后提示 | 新增原生回归，静态候选被独立复现；未声称线上复现 |
| 开发文员 / 三类 development 任务 | 既有 source 款号 | 实际 task.read/execute | 原任务不变 | 外人、母单 source technical、暂停和完成 | 保留原有原生回归 |
| 打版员工 / pattern_room_order | 仅自身款号 | PatternOrderReader 对本人通过、外人 404 | 原待办保持 pending | 外人收件残留、取消子单、失 capability、停用账号、暂停 source | 保留原有原生回归 |
| production_detail | exact child reader 返回的 firstStyleNo；不带母单/价格 | 必须委托 SourcingProductionService.get，403/404 拒绝 | 只写 receipt | 错绑、子阅读拒绝 | 组件委托回归；生产动态待办原已有身份，不列为新实机缺陷 |
| rework_detail / process_configuration / whole_order_review / responsibility_detail / own_factory_approval | exact child reader 返回的 styleNo；绑定 reworkOrderId 必须相同 | 必须委托 ReworkBusinessDetailService.get | 只写 receipt | 错绑子单、取消返工、子阅读拒绝 | 组件委托回归；不替代修复部署后的多角色 UAT |

原生测试只运行本轮拥有的 PG16 容器及独立 schema，测试用户为非超级用户。角色/人员 fixture 初始化和角色失效模拟只对其测试 schema 短暂关闭指定 fixture 触发器并恢复，通知实际授权、阅读服务、状态检查不被 mock。超时通过临时恢复式 Date.now 时钟推进，未改实际业务日期或数据库。

旧版 130a58e 原样替换 notification-service 的失败对照：新增会计与非主跟单两例均在 context 应有款号处失败（实际 undefined）；恢复候选后通过。

本地最终检查：通知完整 schema 13/13；通知 thin schema 与完整业务链合计三组 76/76；子阅读委托 10/10；普通测试 423 文件、2126 通过（60 文件、510 环境相关测试跳过，原生三组另行实跑）；lint、typecheck、全量 build 及其 postbuild 本地业务链、migration lint、secret scan、diff check 均通过。当前 Head 的远端 FULL Gate 和一次 Codex Review 另以 PR 记录为准。

sample_detail / supplier_onboarding / wage_period_detail 不映射数字母单，legacy 入口不在本 PR 范围。DingTalk delivery-worker 部分类别身份缺失是独立静态风险；数字子单已有 enqueue/delivery 双抑制，本 PR 不改外部发送，不宣称已修该风险。

没有部署、真实订单写入、ECS、服务重启、权限扩大或 homepage 变更。合并后仍需用户部署候选，由唯一浏览器执行者复测 UAT315 及相关允许/拒绝路径。
