# 尾查分人方式统一：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 23e875e3fe764064ec8ce51b69bd6be5a7bb7f4f
working branch: fix/v1-tail-assignment-parity
task scope: 尾查复用普通工序的正式工/临时工选择 UI 与实际分配、报数链路
allowed files: 尾查分人前端；统一执行候选人/分配/临时工代报；前向迁移与 manifest；对应测试和本说明
forbidden files: N01、IE 核价规则、工资、责任、收货、钉钉、附件、导航、部署配置及历史迁移
```

本 PR 不新增角色、不删除尾查工序、不调整节点状态机，不做无关重构。
