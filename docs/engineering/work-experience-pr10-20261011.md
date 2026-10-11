# PR10 唯一创建、板房旧业务与统一待办目的地

《第二轮更新.md》PR10，目标 release/digital-production-v1。左侧设计师创建区域只保留母单创建。独立打板、杂事看板接入板房管理台独立页签，直接使用原组件、价格及角色权限；有权人员可新增独立打板或新增杂事，历史轮次、工资、取消费用继续从原详情办理。原价格管控、数据沙盘保留。纯旧板房岗位在统一页使用原权限，不因此得到数字业务权限。

独立大货产前准备菜单退场，旧 workspace=preparation 入口确定性接入大货纸样与唛架工作区，选中母单 ID 保留；实际产前阶段和仓库预缩、纸样/唛架原办理仍保留。独立旧 URL 继续可读取，没有删除历史能力。返回独立板房列表带搜索、类型和页码，不落首页。一级分组保持展开提示，不重复画选中框，当前子页独立高亮；三业务页签在手机换行。

站内待办和 API 通知统一调用受 schema 验证的 todoDestination，保留真实任务、轮次、开发轮和已发布制单版本；原任务对象校验和办理权限不变。界面用具体办理/查看文案，去掉“进入原办理”中转称呼。

定向 23 项通过；九角色实际 React + 完整编译 CSS 浏览器矩阵通过（Root、设计师、文员、主管、工人、跟单、仓库、财务、无角色），五宽度无页面溢出或 JS 错误；390 宽像素已看。浏览器使用 TEST 拦截响应，仅验证组件/路由，不代表 Acceptance 业务验收。全套及真实隔离 PostgreSQL 最终检查正在收口。证据 /workspace/pr10-evidence、/workspace/pr10-focused.log。

没有改变原角色创建资格、计价、工资、审批和状态机，没有部署、网络修改或真实数据操作。外部 Full Gate 与一次必要 GitHub Codex Review 以最终 Head 为准。

最终本地全套 2216 通过、525 数据库条件跳过；真实隔离 PostgreSQL 原业务链 29 文件、320 项通过。最终类型、lint、构建、secret 与 diff 检查通过。九角色矩阵的杂事按钮按原角色表断言（设计师/跟单等原有资格，主管未获额外创建权）；手机业务页签换行修复后再次通过。证据 /workspace/pr10-final-tests.log、/workspace/pr10-local-postgres-business-chain.log、/workspace/pr10-evidence/browser-final2.log。

唯一 GitHub Codex Review 的返回上下文 P2 已修复：内嵌列表将当前允许列表路径传给创建入口，两个 create 链接实时携带 q、kind、status、creatorId、workerId、page；初始来源使用原 validPatternReturnPath 同源白名单校验。没有新增开放重定向或权限。

25 项导航/历史/深链测试通过；实际 React 原创建表单、原详情与 SPA 路由验证两类创建：筛选与人员、第 3 页→取消→同筛选页；再次创建并提交→原详情→同筛选页。制作资料仍按原必填条件上传合成 TEST PDF，未改校验。九岗位、五屏宽导航矩阵再通过，已逐像素查看两类返回的 390 宽页面。lint/typecheck/Web 构建/secret/diff 通过；证据 /workspace/pr10-evidence/create-return-review.log、browser-review-final.log 与 /workspace/pr10-review-*.log。修复以新 Head Full Gate 为准，不触发第二次 Review。
