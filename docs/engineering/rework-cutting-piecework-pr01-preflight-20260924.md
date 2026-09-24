# 返工/裁床计件 PR01 预检

repository: lizhonghao31-crypto/dx-rework  
base branch: main  
base SHA: c77f6f73ab109f1b4647d78e794cda7c35f398e0  
working branch: feat/rework-source-context-kind-20260924  
task scope: 建立返工类别基础并贯通明确的裁床/收货来源到返工创建页，自动带入款号、加工厂、跟单和款图，不开放本厂做尾流程。  
gate class: FULL

## 允许范围
- 0213 前向迁移与 manifest。
- 返工合同、发起服务、收货入口上下文和精确款图读取授权。
- 返工创建页现有字段自动带入及紧凑款图展示。
- 对应测试、需求金标准和本预检。

## 禁止范围
- 不开放“本厂做尾”入口，不改变 N06→N07 现有 QC 状态机。
- 不修改固定工价、包装 collective、裁床计件或财务工资。
- 不修改历史返工单价格、责任、工资和附件。
- 历史无明确 cutting_order 关联的收货记录不得按款号猜加工厂/跟单/款图。

## 重名审计施工原则
本 PR 不对生产工序目录做写入。后续 PR03 开工前只读盘点 process_id、名称、当前版本、价格、默认人员及历史引用；被历史引用的旧工序不得删除或改写。
