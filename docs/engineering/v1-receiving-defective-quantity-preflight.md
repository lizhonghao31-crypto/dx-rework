# 仓库收货次品数量：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: b62fc08a6e3930407d3bb78d85e8ba76de044c57
working branch: feat/receiving-defective-quantity
task scope: 收货登记新增“次品数量”，按单次事实保存并在收货看板累计展示
allowed files: 0095前向迁移及manifest；receiving routes/service；收货页与收货看板及必要的一行网格适配；对应测试；本预检与对应需求文档
forbidden files: 既有迁移、差异计算、返工自动创建、KPI口径、权限、其他节点、工作流与部署配置
```

本 PR 通过前向迁移增加新事实和批次修正量，不修改任何既有迁移或历史收货记录。
