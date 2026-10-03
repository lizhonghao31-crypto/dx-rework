# A3 预派人员回显（2026-10-03）

## 一次预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1；base SHA: 209b00854c217c9fd2e5a6bbc0f5096c0016df0a
- working branch: fix/development-dispatch-prefill
- scope/allowed: 开发执行面板加载顺序、离线浏览器回归、本记录。
- forbidden: API、权限、业务数据、数据库、原打板工资门禁、部署；不扩展 A4。
- gate: FULL（用户要求）；draft，不合并、不部署。

## 复现与修复

QA 发现任务主办已经保存，但重开开发单时三个预派下拉框仍显示“请选择”。
本地实际 App 使用合成已保存 dispatch，候选人员延迟 700ms 返回；三个 select
有正确人员 option，却都 value=""，独立复现。后端读接口正确返回 camelCase
的三个 worker ID，未发现保存丢失。

原因：先 setState 挂载非受控 select，其 defaultValue 对应的人员 option 尚未
到达；稍后增加 option 不会重新应用 defaultValue。
修复仅在候选人员就绪后发布执行面板状态，使首次挂载及版本变更重挂载时即有
匹配选项。沿用原表单 key、非受控输入、请求及权限，不自动提交或改派。
候选读取失败时显示原错误，不展示一组容易被误认为已清空的预派框。

## 本地验证

Node 22.22.2 / npm 10.9.9：定向 ESLint、web typecheck/build、物料刷新单测通过。
`scripts/acceptance/development-dispatch-prefill-regression.mjs` 对本地 Vite 运行真实
App，所有 API 均由隔离合成响应替代，仅模拟预派 PUT；拒绝其他写请求。
覆盖延迟候选后全部正确回显、只改纸样仍保留裁板/车板、保存及重开、候选读取失败
和恢复。原行为三个 value 均为空，补丁后上述回归通过。

```bash
npm run dev --workspace @dx-rework/web -- --host 127.0.0.1
# 测试环境需提供 Playwright；可用 CHROMIUM_PATH 指定现有 Chromium。
node scripts/acceptance/development-dispatch-prefill-regression.mjs
```

本修复与 #619 导航修复无依赖、无同一代码文件修改，均基于 release 209b008。
可独立合并；最终组合仍应在线复测。Full Gate 证据见对应 PR 当前 Head。
代码尚未上线，不宣称 Acceptance 原记录已复测通过。
PR607 seed 是否现场执行仍待证据，本修复不补线上档案、不绕过原单分配与车板工资门禁。
