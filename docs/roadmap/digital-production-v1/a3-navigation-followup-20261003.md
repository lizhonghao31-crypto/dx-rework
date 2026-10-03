# A3 同页详情导航修复（2026-10-03）

## 预检与范围

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1（本次用户明确指定，非默认 main）
- base SHA: 209b00854c217c9fd2e5a6bbc0f5096c0016df0a
- working branch: fix/digital-detail-query-navigation
- scope: NAV-01 数字生产同路径 query 变化后打开对应详情，保持关闭与历史导航一致。
- allowed: App 数字生产入口、数字生产页关闭回调、开发单/制单导航保护、离线回归脚本、本记录。
- forbidden: API/权限/数据库/业务数据/部署配置/生产操作；不扩展 A4。
- gate: FULL；不合并、不部署。

## 证据与根因

Acceptance 浏览器 QA 提供两条独立复现：板房师傅任务的“查看开发单”只更新
`?development=...`，仍显示任务列表；订单跟单产前“查看本轮制单”只更新
`?instruction=...`，仍显示产前页。后者刷新立即显示已存制单，不能误判权限失败。

共享导航已通过 pushState 更新 App 的 search；数字生产页的详情状态只在首次
useState 初始化读取 URL，同路径导航沿用实例，因而保留旧面板。
关闭回调原本直接 replaceState，未同步共享路由内部位置与历史索引。

## 修复

以共享路由的 search 为数字生产页面实例 key，query 导航与前后退均读取目标
详情 ID、开发轮次、制单版本或任务 ID。仅重置数字生产页面，不重挂共享 Shell。
六类详情关闭统一经过原 navigateInternalPage 的 replace 路径，同步路由与历史；
仅在导航成功后清除局部详情。开发单与制单向共享导航注册未保存/写入状态保护，
返回、同页链接和前后退共用一次原文案确认；取消保留输入，写入中拒绝离开。
制单自动保存可能在确认框打开后启动，确认返回时再次检查写入状态，避免丢弃进行中的请求。
页面刷新/关闭通过 beforeunload 保留浏览器原生保护。
不使用 location.reload，不修改权限或业务接口。

## 本地验证

Node 22.22.2 / npm 10.9.9。运行真实 App、共享路由与详情组件的离线浏览器脚本：

```bash
# 在单独终端启动本地 Vite
npm run dev --workspace @dx-rework/web -- --host 127.0.0.1
# 验证环境需提供 Playwright；可用 CHROMIUM_PATH 指定已安装 Chromium
node scripts/acceptance/digital-query-navigation-regression.mjs
```

脚本仅允许本机前端，拦截所有 API；全部使用合成 ID 与响应。仅允许两类
编辑器的模拟 PUT，并暂停/返回模拟失败以验证写入保护，其他写请求一律拒绝。
真实任务链接与产前制单链接、直链、Back/Forward、不同单号/轮次/版本、关闭后
不重开及同链接再次打开均通过。详情响应故意提供带请求路径的隔离错误，用于
验证正确面板与请求参数及错误时可返回；不冒充完整业务详情或权限验收。另提供合成可编辑开发单及制单，验证脏数据
Back/同页链接/返回取消后输入保留、一次确认离开、保存中禁止离开，以及
确认框打开期间制单自动保存启动时仍不得离开。
移除入口 key 的原行为在首条任务跳开发单断言超时，可复现原缺陷。

定向 lint、web typecheck、web build、导航保护/标准工人档案/物料刷新共 6 项
单测通过。Full Gate 与 Review 以 PR 当前 Head 的远端记录为准。

## 续测边界

本补丁未上线，用户未来部署后再在线复测两条原记录。
PR607 的 worker-people 补齐逻辑在本基线中，相关 2 个用例通过；是否实际执行
Acceptance seed 仍需现场证据，不能仅从缺档案现象认定代码回归，也未补线上数据。
QA 已确认的制单保存、图片上传、日期发布拦截、发布快照只读及权限拒绝不列新问题。
通知截图本地读取仍受阻，本 PR 不凭图片描述修改通知 UI；另行收口通知根因。

## GitHub Codex Review

首次 Head 288bb61 的 Full Gate 通过后发起唯一一次 GitHub Codex Review。
Review 的 P1「query 重挂可能丢失未保存内容」已核验有效并补齐上述两编辑器保护及
真实浏览器回归。实质修复后对新 Head 重跑 Full Gate，不机械追加第二次 Review。
