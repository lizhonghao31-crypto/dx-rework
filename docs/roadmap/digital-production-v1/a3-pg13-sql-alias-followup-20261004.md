# A3 PostgreSQL 13 显式列别名兼容修复

## 范围与预检

- repository: lizhonghao31-crypto/dx-rework
- base: release/digital-production-v1 @ 9330b035b44c983b7bd39897eae710272f9d3f14
- branch: fix/pg13-explicit-sql-aliases；Gate: FULL；交付 draft，不合并、不部署。
- 目标：修复 PG13 不接受的裸列别名；保留名称、返回字段、参数、权限、状态及金额规则。
- 允许：五个 API 源文件、当前全 schema 业务链测试、其中导入的 owner 权限测试及本文档。
- 禁止：migration、manifest、角色/权限、数据补写、线上 PostgreSQL 版本、部署工具及 main。

## 问题与确认

619–623 合并候选9330的构建、静态检查、1914项无DB测试及三组本地浏览器回归通过。
扩展真实PG13.23业务链时，92项中79通过、13失败。初始失败归于：

- 流程分析 `next`；板房分段金额/工时转派和取消 `valid`；历史读取 `at`。
- 当前 owner 权限测试自身使用裸 `owner`。
- 两项工资数量/历史回填断言依赖同文件先前场景创建的事实。

相关生产文件与209b008（618）基线Git blob完全相同，不是619–623合并引入。
在独立postgres:13.23容器中实际 `SHOW server_version` 为
`13.23 (Debian 13.23-1.pgdg13+1)`。只读最小查询 `SELECT 1 next/valid/at/owner`
均报42601；对应显式 `AS` 查询通过。客户端版本不作为服务端证据。

第一次仅修别名后，92项变为89通过、3失败；两项原工资/回填断言保持原样并通过。
前序被valid错误中断的分段、取消和工时场景恢复后，工资材料化数量及
MISC-分段实际工时回填恢复。剩余三项继续定位为历史查询中的 `name`，而非改断言解决。

## 一次同类SQL检查及最终改动

从TypeScript AST抽取1950条SELECT/WITH静态SQL字面量，在只读PG13连接中通过
PREPARE检查语法，不执行查询或修改数据。额外检查108个带插值模板的固定部分，
插值占位导致的语法错误人工排除，不将模板占位结果称为完整动态SQL验证。

新增确认并修复 `label/name/mode/version` 同类问题。最终仅17处生产列别名和
一处当前owner测试别名加 `AS`：

- pattern-room/order-service：3处valid。
- pattern-room/order-reader：2处人员姓名name。
- reporting/workflow-analysis：next和两处label。
- reporting/management-reporting-exceptions：label。
- rework/rework-node-history：at、三处name、mode及三处version。
- member-module-policy-postgres.cases：owner。

静态检查剩余两处为被调用方补全的SQL片段；当前真实业务链执行完整拼接。
另发现旧责任测试裸version，但该套件只初始化0010，已因当前服务需要temporary_code
在beforeAll失败；旧管理报表测试固定0053而当前为0233。这些历史测试并未完成当前schema
业务测试，不计通过，不借此次别名修复重建历史夹具或修改迁移。

新增当前全schema回归验证板房人员筛选返回真实id/name、工人仍403，以及带全部筛选
参数的管理异常查询。原工资金额、条数、回填和权限断言均未减弱。

## 真实PG13全业务链结果

独立loopback PG13中建立带隔离标记的测试DB；使用NOSUPERUSER/NOCREATEDB/
NOCREATEROLE/NOREPLICATION/NOBYPASSRLS测试角色，复用现有数据库目标守卫和Gate。
本地只限制测试进程CPU并发，不改应用配置或数据库服务器版本。

```bash
NODE_ENV=test \
TEST_DATABASE_URL=postgres://dx_pg13_test@127.0.0.1:55433/dx_pg13_full_test \
DX_REWORK_REQUIRE_TEST_DATABASE=true \
taskset -c 0 node scripts/run-business-chain-gate.mjs
```

最终：29文件、275测试通过；BUSINESS_CHAIN_GATE_PASSED；23个本次所属schema精确清理成功。
覆盖外发PR03、P07、P10–P14、回货、N01–N11、工资及结算、分段/返工/取消、Root两条
全流程HTTP链路、非Root权限拒绝、Acceptance角色与单人补档，以及浏览器/存储静态边界。
OSS未配置，本地OSS运行预检明确跳过，不称线上存储链已验证。

首个全链执行与另一套DB测试并行导致清理阶段out of shared memory；清理恢复完成，
独立串行全链重跑全部通过。这是本地测试锁资源问题，不改服务器锁配置掩盖业务错误。
额外相关财务工资测试3项通过；前述两套过期历史夹具失败、14项未执行明确保留。
定向ESLint、API typecheck/build通过。最终PR Head仍须既有Full Gate完整通过，
其中真实数据库为PG16，作为同一补丁在新旧服务端上的对照。Gate后仅一次GitHub Codex Review。

## 部署状态与后续

已正式读取用户回传的完整145行部署日志：9330更新成功，Acceptance schema236/0233、
pending=[]、PM2 online、本地/公网版本与资源验证成功、生产3201 ready、备份成功。
安装工具仍为209b008，正常完成更新；业务SQL错误不等于部署失败，不建议盲回滚或重复update。

9330已包含623只读人员检查，目标pattern-room-worker及既有app_user_id
1494c445-fe65-4c24-95cc-72620360adb6；该工具可以继续只读核对，不依赖本补丁。
本次补丁无migration，与并行main转厂任务的迁移编号无冲突。
本补丁尚未合并/部署；旧PG13流程报表、板房转派/取消和历史读取现场复测仍待未来部署。
