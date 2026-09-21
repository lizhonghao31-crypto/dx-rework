# 外发历史页面加载状态修复（2026-09-21）

## 预检
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 1f38fe4603b95faba2e7b08b9a3361f604735951
working branch: fix/sourcing-history-loading-20260921
task scope: 历史数据加载中不提前显示返回按钮，失败时保留紧凑的返回入口。
allowed files: apps/web/src/sourcing-node-history-page.tsx; 本文
forbidden files: 其他页面、API、数据库、权限和业务状态机
gate class: FULL

## 原因与完成标准
原加载与错误共用分支始终渲染返回链接；链接在页面网格中横向拉伸，造成先出现整行按钮再出现历史内容的视觉跳变，并非实际返回当前节点再跳转。

正常加载只显示状态提示并标记 aria-busy；失败显示错误及既有导航布局内的返回入口；成功后的完整只读历史页面保持现状。

## 验证
提交前执行 Web TypeScript 和该文件 ESLint 检查。GitHub Full Gate 以本 PR 当前 Head 的运行结果为准。部署由业务负责人执行。
