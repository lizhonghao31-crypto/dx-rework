# V1 上线前 PR-12 预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: d3d265bd8c91ecaa14b09d3d9c12677521cd486e
working branch: codex/v1-prelaunch-performance-pr12
task scope: 缩短人员分配、收货图片上传与整单复核提交后的等待时间，同时保持现有业务校验和幂等边界。
allowed files: apps/web/src/concurrency.ts; apps/web/src/work-reporting-form.tsx; apps/web/src/whole-order-review-panel.tsx; apps/web/src/receiving-page.tsx; tests/unit/v1-prelaunch-performance-pr12.test.ts; docs/engineering/v1-prelaunch-pr-12-preflight.md
forbidden files: apps/api/**; apps/api/migrations/**; packages/**; 钉钉配置；权限规则；状态机；金额与数量口径；部署配置
```

## 风险边界

- 人员分配沿用原有单人任务接口、独立幂等键、服务端权限与版本校验；客户端并发上限为 3。
- 收货图片沿用原有压缩、哈希、OSS 直传、finalize 与收货绑定链；客户端并发上限为 2。
- 并发队列在首个错误后停止派发新任务，并等待已发请求全部结束后再向页面返回。
- 整单复核写接口返回的服务端事实直接回填当前面板；尾查驳回仍保留完整刷新路径。
- 不改变 UI 布局、业务规则、权限、数据结构、状态流转、审计或钉钉 outbox。

## 回滚

回滚本 PR 即恢复串行人员分配、串行收货图片上传及整单复核提交后的完整重复刷新；没有数据库或数据回滚步骤。
