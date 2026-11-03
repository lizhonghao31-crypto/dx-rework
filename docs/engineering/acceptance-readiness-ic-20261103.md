# Acceptance I＋C 定向修复

目标分支 `release/digital-production-v1`，实际基线 `8ecfbb17b7f2b69905ae326642d1aea96b7bb0a7`；工作分支 `fix/acceptance-readiness-ic-20261103`。本轮只提交草稿 PR，不合并、不部署、不操作现场。沿根 AGENTS V3.1，风险 FULL；不继承 PR894 的单次免审决定，不发重复 Review/最终 Gate。

## 问题来源与完成标准

父会话转交现场 I：母单 `bdaa1a51-46b9-4955-9ed0-bb597e0981a8` 黑 PO1 款号唛有效且已裁1，追加白 PO2 时“新增另一物料”清空固定只读单位，页面无法保存。现场 C：母单 `86f4648b-e50f-4f45-8d99-edb59e1184c2` 的同业务时间两版局部准备，刷新后全完仍409，request `efad9a0f84beaf792ff837d43c3b96f4` / `9b65e9fa38ad863efdb97b75a54cfda2`。这些是转交的现场证据，不是本 Work 访问现场所得。

Pro方案链接未在本 Work 读取；本轮独立核对固定基线代码。A预缩与B返工厂候选不属于本PR，未改代码或开始施工。

1. I只修新增/选择款号唛明细时的单位状态：保持“枚”；非款号唛仍沿原行单位。提交仍复制原明细，只追加明确的新行，不替换黑PO、不改实裁、不扩大仓管权限。后端计件/版本/同单范围与枚个件归一保持原样。
2. C保留所有准备范围历史；API按 `preparation_id,kind,version` 稳定返回，页面在当前 preparation＋成果类型内明确取最大version，不以发生时间或UUID决定当前版。不把局部记录写成整项完成，不改变原服务的409、幂等、权限、技术revision或48h时钟。

## 实际入口及旧消费者

|规则|写入/读取落点|旧消费者与边界|定向证据|
|---|---|---|---|
|I 新行只读计件单位|`ProductionReadinessPanel` 的明细选择onChange；原submit复制其余行；原`ProductionReadinessService.record`|`PreparationMaterialRecordSchema`仍拒箱/包/米和小数件数；原`styleLabelCuttingReason`按真实PO计算；旧行切换/非款号唛单位保持；旧页/同角色并发继续409|新增PG黑PO已裁1→追加白PO；原单位合同；原组件双宽成功/冲突/只读|
|C 当前范围版|`ProductionReadinessService.read`原范围查询；`BulkPreparationRangeAction`当前分组最大version|`BulkPreparationService.complete`仍以数据库最大version锁定校验；原`completeBulkRangeFixture`过滤后末版读取现在与API一致；节点材料一览及目录仍读全部历史，不丢版本；`preparation-todos`使用其原独立repository范围，不改其时钟|固定同时间逆UUID历史；独立唛架；真实旧页及并发409；原48h/65h晚17h；前端乱序＋旧准备v99不串当前|

未改数据库结构、迁移、业务写接口、SLA或权限；不回填、不重排数据库旧记录，不刷新任何已保存的计时/完成事实。表单组件、按钮、布局及CSS沿原实现。回退只能撤三处代码修复，历史仍保留；重新出现的单位/版本问题不能用清历史或调时掩盖。

## 验证及证据边界

- 自建本地独立 PostgreSQL 16.15，数据库带 `dx-rework-isolated-test-v1` 标记。测试角色的 superuser/createdb/createrole/replication/bypassrls 均false；原286迁移、角色seed及身份守卫未放宽。原fixture完成后自有 `business_anchors_*` schema余数0。没有连接 Acceptance 或生产。
- `production-readiness-postgres.test.ts -t 'preserves black PO|orders same-time|partial ordinary-order|rejects stale parallel edits'`：4通过、0失败、19明确未选择；不是整文件或整个系统通过。
- 新I用原命令登记黑PO标签、实际裁1，再并发追加白PO：一次成功一次409；黑明细和实裁1不变，旧版本保留，跟单不能代仓管写。
- 新C以原准备/任务构造确定性的既有不可变范围夹具：同一业务时刻，纸样v1 UUID大于v2，唛架v1独立。后续全部通过原服务命令：旧版409、并发一次成功一次409、刷新后完成。原截止不变，65h完成仍比48h晚17h，历史纸样1/2/3/4和唛架1/2全部保留。没有修改旧行或关闭触发器。
- `production-readiness-contract.test.ts`：3通过，保持计件/非法单位/重复行原守卫。第一次筛选命令另含不存在的旧猜测路径，实际仍仅此文件3项，不将其称其他套件通过；随后使用准确路径重跑并留证。
- `production-readiness-browser.mjs`：14通过（7场景×1280/1440），实际原 React 组件＋从PG捕获的TEST响应、模拟HTTP故障。正常/冲突/只读、黑白PO新增及切回旧行、单位只读、范围乱序/独立类型/不同准备v99、失败保留输入均实际点击。页面错误0、横向溢出0。新成功两档4张、单位冲突1280及范围冲突1440已目视；没有布局/CSS改动。其余场景有自动交互/截图证据，不冒称逐张人工审图。
- 浏览器首轮新用例因标签精确匹配写法超时；当轮原正常/冲突/只读3项已通过，其余未执行。只修测试定位器后完整14项通过，没有改产品来迁就测试。原失败日志保留。
- Typecheck通过；最终Lint和原生预检以同提交内construction-evidence的实际结果为准。构建共享packages用于现有模块接线已完成，未额外做完整本地build或远端Full。

本地日志、结构化报告、输入指纹与截图位于执行环境 `/workspace/ic-readiness-20261103/`，不是用户附件或现场交付证明。提交内construction-evidence记录实际命令、结果及摘要；已变声明输入不能复用。草稿PR的自动light单独报告，未运行的Review/最终Full/现场复测均不得记为通过。
