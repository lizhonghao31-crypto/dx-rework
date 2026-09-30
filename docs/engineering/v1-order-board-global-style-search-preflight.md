# 收货订单看板全局款号搜索：施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 22006cfca1c04fffd9971eec67b3f9af49128f5b
working branch: fix/order-board-global-style-search
task scope: 输入款号时跨全部收货日期查单；清空款号后恢复所选日期看板
allowed files: receiving-service.ts；order-board-page.tsx；对应单元/集成测试；本预检与需求文档
forbidden files: 收货写入、差异算法、数据库迁移、权限、返工流程、其他页面、工作流与部署配置
```

搜索模式只放开读取时间范围，不修改任何收货事实；日期模式继续沿用原有统计口径。
