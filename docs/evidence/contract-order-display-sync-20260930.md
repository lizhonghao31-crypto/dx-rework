# 合同交期及显示一致性修复预检

repository: lizhonghao31-crypto/dx-rework  
base branch: main  
base SHA: e54d8a9c87956aed3aaa52f2803cfe11398e9a39  
working branch: fix/contract-order-date-sync-20260930  
task scope: 合同交货日期同步订单当前显示，并修复 PR #598 Review 的编号显示和模板继承问题。  
allowed files: 合同/订单/生产/裁床/回货读取、合同日期 schema 与编辑框、0220 migration/manifest、定向测试和需求文档。  
forbidden files: 原订单及审批/派单快照写入、财务锁定权限、生产部署与数据。  
gate class: FULL

完成标准：当前交期同步、历史日期保留、已保存日期直接生效、财务核对后拒绝修改；各处编号按关联版本一致；款号修订不吞掉待同步模板；本地完整合同回归、Full Gate 和独立 Review。

## Full Gate 测试入口修复

Gate 36686300281 在执行映射的 PostgreSQL 用例时，将 `.cases.ts` 模块误当成 Vitest 独立入口，报 `No test files found`。补齐当前六个共享用例模块到实际 `.test.ts` 导入入口的映射，校验拒绝非测试入口，保留数据库敏感路径升级规则。新增映射回归并修正原样衣策略测试中同样错误的入口预期。修复范围扩展至 `scripts/ci/full-gate-risk-map.mjs` 及其两个单元测试。
