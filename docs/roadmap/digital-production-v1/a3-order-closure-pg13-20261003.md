# A3 P14 结案读取 PostgreSQL 13 兼容修复（2026-10-03）

## 预检与范围

- repository: lizhonghao31-crypto/dx-rework
- base: release/digital-production-v1 @ 209b00854c217c9fd2e5a6bbc0f5096c0016df0a
- branch: fix/order-closure-empty-read；Gate: FULL；draft，不合并、不部署。
- scope: OrderClosureService读取SQL的一处列别名、现有全schema链路测试与本记录。
- forbidden: migration、权限、业务数据、结案/金额规则、部署配置和ECS操作。

## 业务阻断与根因

QA在两张TEST母单、设计师/总监授权路径发现“回货与结案”读取反复500。
既有获批订单和未外发订单均复现；不能归因新外发或无权限。无实裁/发厂/回货时
本应展示零实绩和未清事项，特殊结案与原实绩验收因此阻断。

本地启动独立、仅loopback端口的postgres:13.23容器，执行SHOW server_version，
确认服务端为 `13.23 (Debian 13.23-1.pgdg13+1)`，未以客户端版本代替。
全量schema迁移及合成业务夹具下，既有两条P13/P14链路均在
OrderClosureService.read待办查询处失败：`syntax error at or near "label"`。

待办名称的标量子查询使用裸列别名 `) label`，PG13解析失败，查询即使没有待办行
也会报错。改为显式 `) AS label`，保留所有查询条件、返回字段和结案规则。
无migration、无数据修复、无权限放宽。

## 真实PG13验证

同一13.23容器内：

- 修改前两条P13/P14链路均失败，错误位置与上述SQL一致。
- 修改后两条原链路通过，覆盖正常装箱完成/特殊结案、原回货与返工事实、拒绝无权
  结案、旧revision拒绝、幂等和并发屏障、Root更正及不可变结案记录。
- 新增无实裁/回货/装箱测试通过：设计师、总监、跟单读出两款色零实绩与未清事项，
  canClose=false，不创造原事实；无关设计师仍404。
- 定向ESLint和API typecheck通过。

```bash
# 仅使用已建立的本地隔离数据库，不能替换为线上连接。
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/dx_local_p14 \
  npx --no-install vitest run tests/integration/sourcing-pr03-postgres.test.ts -t P14
```

结果：1文件、3测试通过（其余53项未选择，不计通过）。Full Gate仍以PR最终Head
为准，CI数据库版本不替代本次本地PG13证据。

与#619/#620/#621无代码文件重叠及合并顺序依赖。本补丁未部署；两张原TEST记录的
在线读取、特殊结案及原实绩复测仍待用户未来部署，不宣称线上问题已验收。
