# 2026-09-24 返工/裁床计件建设 PR01 预检

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: c77f6f73ab109f1b4647d78e794cda7c35f398e0
working branch: feat/rework-source-kind-foundation-20260924
task scope: 建立返工类别基础，并把明确的裁床→收货来源继续传递到返工创建，自动带入原加工厂和订单跟单。
gate class: FULL

## 重名审计结论（代码事实）

当前公共返工工序目录是可变主数据，并不存在一份由 migration 固定写死的生产工序名称清单；工序可由主数据服务创建，也可由历史自定义返工工序晋升为公共工序。因此仅凭 GitHub 无法安全判断线上“包装/查货/大烫/剪线”等名称是否重复。PR03 在新增固定工价前必须以只读 SQL 对 `current_process_catalog` 按 `lower(btrim(process_name))` 分组核验实际生产目录，再采用“保留历史引用、只治理新选择入口”的策略，禁止直接删除旧 process_id。

本 PR 不写生产数据，不创建固定工价，也不改变 QC 返工状态机。
