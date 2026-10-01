# P14 回货、返工、装箱与特殊结案

- repository: `lizhonghao31-crypto/dx-rework`
- target base: `release/digital-production-v1`，P13合并基线 `ebe53c77cd6b9162860b0501750a46f935c7934d`。
- working branch: `feat/digital-production-p14-order-closure`
- scope: 原回货/返工来源显式关联、原实绩与装箱投影、总监特殊结案。
- allowed: production-platform固定来源适配和结案、receiving/rework插入后适配、原收货聚合复用、任务终止、办理页、migration/manifest和测试。
- forbidden: 部署/重启/线上数据、新收货或工资数量账、历史单迁移、按款号后四位绑单、修改原Root实绩更正规则。
- gate class: FULL

## 来源与数量

原收货插入和原返工创建事务内，以receiving_batches.cutting_order_id→既有cutting子单→稳定母单lineId建立显式来源。多次收货仍是原模块的多条事实，母单唯一。未带新生命周期标识的旧单不迁移、不回填、不按款号后缀猜关联。

共享原receiving的聚合SQL主体，仅将数字母单范围改为明确cutting IDs；累计实收、次品、原Root更正/合并调整沿用原口径。每PO显示原订购、实收、送货单、次数和最新装箱事实。差异处理须匹配当前实绩及装箱版本，过期处理不能盖住新差异。原成衣QC/返工来自source_receiving_batch_id的显式映射，工资仅展示原台账关联条数，金额与工资操作仍在原权限页面。

## 本期结束与例外

各PO原装箱达到订购且无当前未清事项时显示本期装箱完成；不把一色超量抵另一色短量。出柜和客户签收始终未知，不由本期阶段推断。付款、财务核对、工资发放不作为结束条件。

真实在岗供应链总监或既有Root身份可特殊结案；老板身份本身不授予此例外。页面先展示原实绩与未清事项，再填写具体原因和确认；服务端校验资料版本、幂等、权限及审计，保存不可变结案原因和当时未清事项。结束本期未完数字待办，不将原返工/质量/差异/工资标为解决，不改数量，也不伪装成订单取消。结案后原Root纠数仍可办理，页面读取原模块最新实绩，同时保留当时未清快照。

## 本地证据

- API/Web类型、ESLint、migration静态校验与Web构建通过。
- PGlite完整迁移下103项通过，包括P09—P13、旧收货回归及P14多次收货累计一致、显式返工、普通岗位拒绝、总监短装结案、版本冲突、幂等、原数保留、结案后Root纠数继续读取和足量装箱完成。
- 全非DB套件1838项通过，383项数据库测试跳过。真实PostgreSQL并发/升级和旧业务链由最终Head Full Gate验证。
- 桌面和390px手机模拟数据布局无脚本错误/横向溢出；点击特殊结案并核对reason和expectedRevision请求。不是线上验收。

未部署；逐PR门禁、独立Review及合并按实际候选记录。
