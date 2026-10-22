# 合同待办、版本回签及价格重新申请

本轮三个依赖 PR 从 main 分支 64a4483240698c7c6b455ff274fb42d61574ea90 顺序堆叠，不混入 release/acceptance。生产部署、三单预检及补录由业务负责人操作，助手仅实现和隔离验证。每个 PR 使用 FULL Gate。

## PR01 接手与边界

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 64a4483240698c7c6b455ff274fb42d61574ea90
working branch: fix/transfer-contract-reliability-pr01
task scope: 转厂合同就绪同步可靠性，以及严格三单的显式历史预检和补缺失任务
allowed files: apps/api/src/sourcing/合同待办和回签链、apps/api/src/todos/routes.ts、对应测试、对应业务规则/交付文档
forbidden files: 旧迁移、release/acceptance、生产配置/数据、无关业务及全局任务期限策略
gate class: FULL
```

历史入口固定三单和合同文档/版本。预览为只读可重复读事务；证据 hash 绑定原始就绪时间和去重后的接收人/资格，无明文人员UUID输出。执行使用同一订单锁和应用事务、有限锁/语句超时，重新检查回签及任务；签回和正常任务新增允许跳过，换版/换人/资格变化阻断。每单 savepoint，失败回滚并准确报告，批审计只关联实际结果。同请求重试幂等；其他27单不查询、不写入。闭合/阻塞/旧版异常任务不自动取消、改派、重开。

正常合同生成保留原savepoint/deferred审计；未ready新合同不取消仍待办理的旧版任务。合同准备/读取/下载不补历史。现有通知、真实文档接收人去重键、全局due_at策略继续复用。

测试只用本机独立、带标记的PG13测试库与合成订单。集成测试为历史入口配置合成基准注册表，另有真实固定allowlist单测；不读取生产或合同正文。

## 已核对的价格语义

main现有转厂仅收一个unitPrice，对多款行统一定价；需要老板审批的条件为申请unitPrice大于当前decision.unit_price。不是逐行比较，也不存在现有“逐款不可抵消”实现。本轮复用实际基准与多款逻辑，不改变全转厂审批。

PR01 本地验收：Node22.22.2/npm10.9.9；类型、lint、工作区构建、迁移静态检查、完整秘密扫描、生产依赖高危审计通过。全仓无DB测试391文件通过（2,058项，355项按环境跳过）；独立PG13外发链68项全部通过；PG16仓库业务Gate及完整迁移重放/幂等/漂移拒绝通过，外部OSS未配置按脚本跳过。不把PG13的无关模块SQL兼容错误或测试容器锁内存错误当成本次外发失败；仓库Full Gate使用PG16。

main的#802将实收数量标题移入共享组件，两个旧UI源码断言尚未更新。本PR仅修正对应断言；不改返工/收货业务或页面。历史执行须等PR02部署且完成版本周期预检；本PR不执行任何历史修复。
