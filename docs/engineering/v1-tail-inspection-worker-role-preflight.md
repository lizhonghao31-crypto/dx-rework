# 尾查复用工人角色：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 06f503fa8190d8b2452fca24ade8e86df087c755
working branch: fix/v1-tail-inspection-worker-role
task scope: 保留尾查工序，改由现有工人角色承接人员选择和本人报数
allowed files: access 角色目录；统一执行候选人/报数授权；一线入口；前向迁移与 manifest；对应测试和本说明
forbidden files: 历史迁移；尾查工序模型；工序配置 UI；工资、责任、收货、钉钉、附件与部署配置
```

验收只检查：权限管理不再提供尾查角色、工人可被分配尾查且仅能提交本人任务、旧尾查角色仍可兼容历史订单。
