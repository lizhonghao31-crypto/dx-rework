# N05 工人报数驳回原因校验

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1（本轮用户明确指定）
- base SHA: d433a3884d42d0dfb2e6dd6b6e8d6299fbca6e3a
- working branch: fix/n05-report-reject-required
- task scope: 工人报数驳回原因空白时提示必填并保留当前弹窗，取消退出，有效原因沿原请求提交。
- allowed files: system-dialog.tsx 的仅 prompt 可选校验、局部错误样式、whole-order-review-panel.tsx 的 worker 驳回调用、定向测试及本文。
- forbidden files: API、数据库、数量及审批逻辑、其它弹窗调用、认证、移动端重构、部署、main。
- gate class: FULL（共享弹窗增量能力；默认行为保持原样）。

## 根因与范围

原 prompt 在确认时立即 resolve 并卸载，N05 调用方才通过 `reason?.trim()` 拦截空白，因而出现无反馈的关闭。必填校验必须发生在弹窗提交之前，仅工人报数驳回显式启用；整查、IE 退回等其它弹窗保持原行为。

## 验证

使用本机 Chromium、真实 React 组件及合成数据验证空字符串、空格、取消、有效原因和未启用校验的其它弹窗。所有网络请求由测试 fixture 接管，不接触实际订单或线上环境。Gate、Review 和合并证据以 PR 当前 Head 为准；未部署。

- 基线实际复现：空字符串与纯空格均关闭弹窗、不提交，确认缺陷。
- 修复后浏览器：6 组通过；空白点击确认及 Enter 均提示必填、保留输入与弹窗；错误后取消不提交；Escape 不提交；改填有效原因清除错误并沿原 payload 提交一次，原数量仍为 10；其它未启用校验的 prompt 仍允许空白确认。
- 原有定向单测：system-dialog、uat-worker-role-review-ui 共 8 项通过。
- 浏览器执行：`PLAYWRIGHT_IMPORT=<已安装 Playwright 的模块路径> node tests/acceptance/n05-reject-required-browser.mjs`（Node 22、本机 Chromium）；无需新增仓库依赖。
- 本地必要检查：lint、全工作区 typecheck/build、77 项静态业务链、全套测试 2136 passed / 512 skipped、migration 静态校验、工作区 secret scan、diff check 均通过。512 个跳过项为测试的既有无 DB/外部服务条件，不作为实机业务验收证据。
