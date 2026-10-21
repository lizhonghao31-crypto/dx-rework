# P15 ERP原调用方反馈及只读原回执

第三组末项，最终堆叠P14。没有ERP Web客户端，未新增页面、后台任务、业务节点、生产连接或配置入口；没有启用生产ERP/修改专用身份、凭据或公司配置。仅现有v1契约、原调用方及合成适配器验收。管理座舱UI不改。无migration/回填。

## 真实增量

- `erp-integration-service.ts`：已知唯一性/引用/权限/不可变/数据约束拒绝安全说明维护责任和原入口；多种约束共用SQLSTATE时明确未定位具体字段，不猜人员/工厂或默认值，不回显SQL、ID、原请求全文。原键与source.externalIdempotencyKey一致、原金额/数量/映射/来源守卫不改。
- 原专用身份/当前principal、人工应急角色/capability和数据库授权在幂等获取前重核，已完成key不能绕过身份停用或角色失效。原Root特例与ERP专用非人工边界分别保留，不把普通Root当ERP专用身份。
- `erp-integration-routes.ts`：字段错误用安全中文名逐项指出（有界显示并注明余项），保留v1格式、状态码、原机器code及requestId；不输出提交值。来源人员/工厂由接入维护人员先核映射，再到原员工权限/供应商资料入口核对，不自动替换。
- 本地事务提交后适配器确认失败返回`ERP_ADAPTER_ACK_UNKNOWN`，说明本地接入已保存/外部确认未完成。不能说“肯定没保存”或换新键重建；读本地回执不冒称已完成外部同步，不自动补发外部请求。
- `erp-result-service.ts`：保留只读事务/原权限、合法真实0和空数组、应急`linkedErp:null`。坏集合、金额、时间或版本返回`ERP_RESULT_INVALID`，不转成空成功；DB失败经P13公开边界区分读取失败，不暴露内部错误。

## 只读恢复协议

新增GET，只复用原幂等表，无任意actor/scope参数、无写入/获取租约/延长期限/重放/适配器调用：

|路径|身份及固定范围|
|---|---|
|`/integrations/erp/v1/rework-orders/intake-receipt?requestFingerprint=<sha256>`|原有效专用身份、启用适配器与当前principal；固定`erp.rework.intake.v1`、当前actor。|
|`/integrations/erp/v1/rework-orders/:reworkOrderId/link-receipt?requestFingerprint=<sha256>`|同一专用身份；固定link命令，另核对原单，错单409且不暴露实际单ID。|
|`/admin/erp-emergency/v1/rework-orders/intake-receipt?requestFingerprint=<sha256>`|原system_admin及原`erp:emergency_intake`，数据库当前授权；只读本人emergency命令。|

三个回执GET均返回`Cache-Control: private, no-store`及包含Authorization/Cookie/Idempotency-Key的Vary，避免共享缓存复用身份或原键回执。原key仍在`Idempotency-Key`请求头，不放URL。只接受小写SHA256摘要，不接受原请求全文/actor/scope查询。调用方先用原v1 Schema解析其原内容，再对`serializeErpCommandFingerprint(scope,payload)`的UTF-8作SHA256。纯序列化函数与原服务canonicalize逐字节相同（对象localeCompare排序、数组顺序保留），不重写已有hash；link payload保持`{reworkOrderId,input}`。响应`ErpCommandReceiptSchema`区分：

- `confirmed`：原schema、原状态码及命令类型通过，返回原本地回执和原到期时间，不能代替外部适配确认。
- `unconfirmed`/`missing_or_expired`：未取得仍有效回执，不能认定未保存，也不能换key重建。
- `unconfirmed`/`in_progress`：尚无完成回执，只读稍后核对。
- 原键与指纹不符409；已存回执格式坏502；缺权限/停用先拒绝，不泄露有无记录。读取失败保持未确认，不返回假0/空数组。

原ERP幂等保留实际为30天，未改为P10的24小时；此GET不延长。过期后保留原键/内容，由原有权接入维护人员沿原来源审计核实，不自动发写。已知订单ID仍可用原result GET核对。本文响应类别属于接口反馈，不新增业务状态。

## 测试、fixture与已发现的既有边界

路由使用既有Mock/Disabled适配器，检查正常、未启用、人工冒用/缺capability、无效键/指纹/禁止actor/scope查询、原应急权限及本地提交后外部异常；无真实ERP请求。契约/结果单测检查旧hash兼容、正整数、真实零/空、坏投影/时间及DB失败，均不做自动写重试。

真实PG初始化与动作严格分开：当前完整schema的0089迁移默认停用无人工授权的专用账号。仅在本次owned测试schema内显式模拟已配置专用身份，仍无钉钉身份/人工角色，结束恢复原enabled；不改生产默认，也未移除principal/数据库守卫。业务创建/并发/恢复均走真实服务及事务，Root仅用原员工权限服务停用/恢复TEST应急管理员验证撤销，不以直接改库绕过员工守卫。幂等pending/过期/坏回执是明确的系统元数据故障夹具，不替代业务提交。

另发现原v1契约允许非空source.erpNodeId，但当前rework_orders完整提交守卫要求其为空；首轮合成非空值被23514拒绝。本轮不放宽该业务边界、不把节点值偷偷改写或推算。合法null来源与原应急link的非空节点分别取证；非空直接接入的既有不一致保留为ERP专项待确认，不能称全部ERP v1输入已跑通。具体契约是packages/contracts/src/erp-integration.ts的ErpSourceReferenceSchema（erpNodeId: ExternalIdSchema.nullable），实际服务把该值原样写rework_orders.erp_node_id；最终覆盖该插入守卫的既有0109_n04_explicit_execution_completion.sql要求NEW.erp_node_id IS NULL。这两条在本轮起始release基线已同时存在，未被本轮更改。非空直接创建在写事务中被23514拒绝，测试核对订单、接入/事件/幂等/outbox/待办快照均无新增。它阻断携非空节点的直接创建验收及将来声称全v1输入/真实接入可用；不阻断本轮已明确的反馈/受权原回执、null来源创建及原应急非空关联的代码验收。生产接入保持禁用；这不是将该既有缺陷判定已修复或擅自决定节点应该去掉，后续真实ERP启用前必须专项确认并修复。

本次最终本地检查：5组ERP定向24项通过；当前完整叠加版本的实库全链57项及合同资料88项，共145项通过；同步上游后全量测试2683项通过、631项按既有数据库/专项策略跳过，跳过不算通过。lint、typecheck、构建（不执行部署postbuild）及全范围秘密扫描通过。最终HEAD/FULL/唯一Review另在施工账本及PR记录；未完成不得记通过。真实ERP联调、现场专用身份配置及历史迁移后的存量ERP数据未验，不以合成调用代替。

## 恢复/回退

本PR没有库迁移。回退仅代码/错误映射/只读路由或调用方版本，不删除接入、关联、幂等、任务、outbox或审计。原v1写入/结果接口仍在，新增回执不能授普通账号能力。默认ERP禁用保持；部署/启用另待用户明确放行。

## FULL首次超时的定向诊断

3f083950首次FULL39545630431在mapped PG的旧P03关联返工完整业务场景超过默认5秒（56通过/1超时），新增ERP场景通过；没有把该失败算通过。只复制原测试到临时诊断文件，对同一真实服务路径统计SQL/连接耗时，保留原断言，使用已有canonical业务配置取性能证据，不冒称普通Gate。首轮诊断脚本作用域错误为0次SQL，已修正并保留记录。正确诊断：该单场景执行9336条SQL，主体2671ms，最大单SQL19.16ms、最大连接获取5.73ms，最大并发2；没有长SQL/长连接等待证据，云端原例耗时5019ms位于默认预算边界。该用例实际包含旧资料初始化、完整核料/安排/前置执行、四种无效数量/旧版本拒绝及回滚、同键合法返工、原主管核价等整条事务链，不是单个CRUD。

只给这一条已测完整链显式有限15秒预算，保留全部业务断言/权限/校验及其它测试默认值；不改业务等待、重试、SQL或全局超时。临时诊断文件已移出测试树，计数与原失败日志保留evidence/P15。后续新HEAD仍须普通mapped PG与完整FULL真实通过，不能以诊断或canonical较长预算代替。

针对“是否新引入循环/查询放大”另作冻结基线对照（同一owned数据库、同一有界统计、单场景，不作为普通Gate）：P03@0b969e36为8282条/主体2432ms；P12@c87a41a6为9336条/2700ms；P15路径为9336条/2671ms。P12与P15的digital-development-route-fixture内容hash均为eaaaecdc454c45fd8539f10ec36bb39ee4b6ce51；P13—P15对production-platform/pattern-room仅改与本场景无关的制单审计读取投影，未改变该业务链。P03后测试追加P05的主管返工核价、合法0元、越权/擅改人拒绝与同键重放等有界动作（原工艺路径1次、4种无效数量/旧版本组合），不是本轮ERP新增重试或不退出循环。该对照未见最后三PR带来查询增长；不据此宣称全系统性能已审计。两份诊断临时文件也已移出原工作树。
