# 收货看板卡片布局修复：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 5afeccc7d02749ba2ffcb751291a83ee43ff4718
working branch: fix/order-board-card-layout
task scope: 桌面字段互不覆盖并将操作集中到最右侧；移动端一行四项、全部操作同排
allowed files: order-board-page.tsx；order-board-page.css；布局契约测试；本预检与需求文档
forbidden files: API、数据库、附件逻辑、权限、返工行为、其他页面、工作流与部署配置
```

本 PR 仅重新编排既有字段与按钮，不删除字段、不新增组件、不改变业务行为和调色盘。
