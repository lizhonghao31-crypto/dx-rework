# 板房日期部署修复

repository: lizhonghao31-crypto/dx-rework

base branch: main

base SHA: 624edfe745b8ebd69d5417c4ea35a89575b91492

working branch: fix/0912-pattern-calendar-date

task scope: 修复板房要求日期的时区偏移，以及返工全链路测试被其他模块待办干扰的问题。

allowed files: pattern-room/order-reader.ts、full-business-chain-postgres.test.ts、本记录。

forbidden files: UI/CSS、权限/工资算法、生产数据、migration、部署配置、依赖。

gate class: FULL

根因：PostgreSQL DATE 被 pg 解码为运行时本地午夜，再调用 toISOString 转成 UTC 并截取日期；东八区会提前一天。数据库日期本身没有因读取而改变。首个测试在创建订单后中断，残留板房派工待办，后续返工测试对整个测试 schema 的待办做空集合断言，产生第二个失败。

修复：列表与单单读取都由 SQL 按 YYYY-MM-DD 返回纯日期；时间戳字段继续原有处理。返工 N01–N11 的待办断言限定到本单 entity/route，保持待办必须全部关闭的检查，不删除或跳过真实业务记录。

回归：在 UTC 运行的数据库测试中主动模拟 pg 在 +08:00、-07:00 环境下对 DATE 的解析，检查真实列表和详情；创建、编辑回包也检查原日期。复测用户失败的板房首单与返工 N01–N11 场景。本修复不涉及生产数据回填；部署由负责人执行。
