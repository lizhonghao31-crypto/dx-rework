# PR08 开裁、工艺 QC 与实际生产入口

范围为《第二轮更新.md》PR08，合入目标 release/digital-production-v1。待办按真实任务类型直达工艺收发、具体 PO 的 QC 或实际发厂；PO 使用持久 lineId，不按颜色或显示顺序猜测。非法、重复及已不存在的参数显示中文错误，不退回全局办理。裁床及生产上报保留原数据和权限，具体 PO 只通过已有交期行对应持久生产行位置，保留返回母单及原来源列表。

工艺页显示本次真实回仓时间与历史回仓检查的区别；同一回仓轮次 QC 门禁、全部 PO 合格门禁及实际发厂激活服务保持原规则。QC 图片先使用共享图片处理再上传，成功后可预览；失败保留图片与引用，只在该 PO 成功登记后清理。默认事件时间和请求键跨失败重试保持一致，确认成功后才释放；未知实际时间仍按原协议提交 null。没有新增工资、价格、生产数量或权限计算。

验证：本地全套 2197 通过、525 数据库条件跳过；定向深链 3 项通过；真实隔离 PostgreSQL 原业务链 29 文件、320 项通过，涵盖内外裁、两 PO、有无工艺、当前及历史回仓 QC、过期版本拒绝。lint、类型检查、构建、secret 扫描与 diff 检查通过。

实际 React 与完整编译 CSS 浏览器验证 QC、工艺收发、仓库及主跟单四个角色；1440/1280/768/390/360 无页面横向溢出或 JS 错误。指定 PO、图片预处理和预览、409 保留相同请求体/请求键、未全部合格不能发厂、默认实际发厂时间重试不变、无权 QC 只读提示和错误 PO 拒绝通过。已逐像素查看 390 宽 QC 页面。证据位于 /workspace/pr08-evidence、/workspace/pr08-tests.log、/workspace/pr08-local-postgres-business-chain.log 及 /workspace/pr08-final-focused.log。

浏览器使用 TEST 合成响应，仅证明组件和路由行为，不代表线上 Acceptance 岗位验收。没有部署、重启、修改网络或操作真实业务数据；外部 Full Gate 和一次必要 GitHub Codex Review 待最终 PR Head。

一次 GitHub Codex Review 两处 P2 已修复：指定 PO 视图仅保留日报办理，抑制整单生产完成/发货入口与执行函数；“查看全部 PO”只删除 line 参数，保留 factoryDecisionId 和返回来源，完整全单页面恢复原合法动作。QC 使用共享 uploadImageWithNormalizationRetry，服务端声明格式拒绝后浏览器解码重编码再申请上传；只有 finalize 成功的引用进入检查，暂时失败保留未上传原文件并提供显式重试，不重复已成功图片。

修复验证：14 项生产填报/样品图片测试及共享图片管线测试通过。真实 React 浏览器多 PO 在生产中/生产完成两种状态确认单行日报可用、整单按钮不可见、切换全单恢复按钮且保留工厂参数；QC 首次 MIME 拒绝自动重编码为 WebP，随后暂时失败可直接重试未上传文件。原四岗位、五屏宽场景再次通过，并逐像素查看生产填报与 QC 390 宽页面。证据 /workspace/pr08-evidence/reporting-review.log、browser-review.log 和 /workspace/pr08-review-*.log。修复后等待新 Head Full Gate，不触发第二次 Review。
