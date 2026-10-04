# 认证准入与会话撤销（批准风险 1、2、3）

## 冻结预检

repository: lizhonghao31-crypto/dx-rework；base branch: main；base SHA: 9fcc05c49dd7f236e2aad183b7e638780e9d63fc；working branch: security/auth-admission；gate class: FULL。

范围仅 auth/service/routes/postgres-store、app 错误状态、认证与原生命周期测试。禁止修改管理员角色/权限（4、11）、识别费用（9）、migration/manifest、A4 UI、线上配置或数据。repo 及 /workspace 的 .agents 未提供 skills 文件；已读 AGENTS、施工流程、Actions policy、平台权限 Golden Source。远端 release 冻结 dee990729f46e334450b34693bcb72027b07140f。main 221、release 237 条历史在真实隔离 PG13.23 回放成功；本 PR 不新增迁移。

## 已核实与改动

- 1：QR start 和 legacy callback 原无 preHandler；原限流按 IP+路由计数，可跨入口放大。四个公开登录入口统一每 IP 10/分钟、全实例 200/分钟。服务在任何 DB/OAuth 工作前最多准入16个公共请求。保留既有 loopback proxy 信任边界、一次性 code/state 和 browser binding；错误浏览器仍不消耗 challenge。容量拒绝返回429与 Retry-After。
- 2：只合并同一稳定身份当前正在进行的目录读取，完成后立即删除，没有 TTL 身份缓存。每实例最多32个不同身份读、同读32个等待者、64个 protected 工作；失败释放准入，下一顺序请求重新 live 校验。Official provider 原有每次HTTP五秒 AbortSignal 继续有效，不引入失效后后台仍占资源的 Promise.race。授权 upsert 不缓存，返回前重新核验 session 和最新授权，撤销/登出并发不能返回旧结果。
- 3：缺失/停用/离职时 deactivateIdentity 同一事务撤销该用户全部未撤销 session；directory upsert 遇到 inactive/unemployed 也撤销，即使 Root app access 仍保留。正常复职新登录可用，旧 token 不复活。未改业务角色或 Root 能力。

## 隔离证据

- 冻结 main 对候选认证 oracle：4失败/28通过；其中放大/并发/旧请求撤销缺口被检出（阻塞假 store 测试在旧代码上超时）。
- 冻结 main 对真实 PG session oracle：3失败；候选同一 oracle：3通过，涵盖身份缺失、停用、离职后恢复、新登录及 Root access 保留。
- 定向认证/扫码/provider：40通过；完整无DB suite：1851通过、321跳过（跳过项不声称数据库验证）。lint/typecheck/workspace build通过。
- 原 employee-access 生命周期 fixture 把当前manifest最后一项误认0089；复用 release 已有的精确0089选择、history table、正确事件列及 Root actor fixture，保留业务断言。此 suite 和 session suite 在 PG13通过。
- 初次 main 的 mapped access/full-business-chain 在 PG13有16个既有失败；其中3个过期access fixture已按下文修复，另外13个PG13 bare alias故障在冻结base单独复现，未扩展修改业务SQL。不能声称main所有PG13业务链兼容；Gate/Review必须读取准确 Head，不能用此文档代替。

## 运行边界

预算是单进程的；多实例数量乘以预算，不承诺跨实例分布式限流。未在线压测、未调用真实钉钉或收费API。没有关闭扫描 findings。最终 release 接入应仅 cherry-pick本安全提交，不能把 main/release 整支互合；共享源码相同部分可直接适配，迁移历史保持原样。部署次序由组合兼容证据决定，不自动合并/部署。

## 准确Head Gate阻断与最小测试修复

首次Head fb23754e的FullGate37191793458在PG16的mapped access失败3项/通过8项：两项fixture未应用0059临时身份DDL，缺business_people.temporary_code；一项仍断言旧nextCursor，而当前service输出page/totalCount。冻结base9fcc05c4在同一PG13本地逐项重现完全相同3项（日志dx-main-pg-baseline）；与PG13 bare alias的另外13项故障分开记录。

仅接入release已有access测试fixture修正（一个测试文件23增/12删），补齐真实历史DDL片段和0098、按现有page API断言、使用真实事件created_at列。不搬入来源commit0761178e的manifest或任何业务源码。独立diagnostic tree基于准确fb23754e加此一个文件，在真实隔离PG16上access/生命周期/session/全链路49项通过；受本机并行测试压力出现的一次5秒timeout已定位，使用独立60秒测试预算完成本地诊断，不改CI gate/test timeout。本修复不涉及main旧analytics alias；最终新Head仍必须跑原FullGate，再请求唯一一次Codex Review。

## 唯一一次Review的修复

4fef105a通过FullGate后首次Codex Review发现P1：同IP已拒绝请求仍消耗全局预算；P2：legacy callback吞掉AUTH_BUSY而返回denied。两项均用新增回归在准确被审Head复现（2失败/33通过），随后修正为仅IP准入成功才增加全局计数，callback把AUTH_BUSY交给统一429/Retry-After处理，保留未消耗的QR state供重试。修正后35项认证测试通过；最终新Head重新FullGate，不请求第二次Review。
