# Acceptance 三项局部修复（2026-10-18）

业务负责人确认集中修复 cb0015 现场发现的三项问题。本 PR 基于 `release/digital-production-v1@cb0015d92388ca444aaa56bf9eb0f7b3390dd2b4`，预检远端 main 为 `728007c76270614eda15635dea325b7612d7def4`。不纳入 G3/G4，不改 main；最终合并需父窗口核验，部署由用户执行。

## 三项问题与最终改动

| 现场问题 | 修复及边界 |
| --- | --- |
| 特殊结案卡片显示“核对大货准备条件／待处理” | 在 BulkPatternCard 优先呈现“已特殊结案”，保留服务端原结案说明与原详情链接，不再把未满足条件包装为当前待办或显示时限。识别来自现有 BulkPreparationService.gates 固定结案原因的精确匹配，当前 DTO 没有结构化结案字段；相似自由文字不推断结案。原分栏函数、计数、查询、状态机和历史数据不改。 |
| 设计师档案进入沿用任务后返回丢失来源 | 原链接已调用来源 helper，遗漏在设计师严格白名单未接受合法 editor 上下文。仅扩充原设计师来源 schema 的 development UUID、正整数安全轮次、已有类别/章节/文档类型；无开发对象时不接受孤立资料上下文。保持本地路径、前缀、重复参数、UUID、枚举、外站及循环 returnTo 限制，不手拼未经校验的来源。 |
| 长附件名挤压“查看原附件／移除” | DevelopmentDocumentFields 将原两个操作分组；宿主 CSS 让名称区域承担空间变化，操作保持自然宽度和单行，窄容器允许整组转入下一行。保留原链接、图片、移除回调、只读/忙态分支、ellipsis 及键盘全文展开；不改通用 AttachmentIdentity 请求/重试逻辑、共享按钮参数或文件模型。 |

产品只改四个 Web 文件：bulk-pattern-card.tsx、development-workspace-return.tsx、development-document-fields.tsx、digital-development.css。没有 API、contracts、domain、migration、依赖、scripts/infra、CI 或统计口径变动。

## 先红后绿证据

原产品代码上新增定向单元：23 项中 3 项失败、20 项通过。失败为特殊结案真实 DTO（reasons 含结案、preparationId=null、tasks/facts 为空）及根路径/Acceptance 两条设计师来源返回；普通未满足条件保持原指引的正向用例已通过。

原产品代码的实际设计师 Shell 浏览器回归共 10 场景全部失败，0 页面异常/外部请求。其中四个根路径/Acceptance、桌面/手机的真实档案入口均返回后丢失 page；1180px 编辑附件“查看原附件”实测约 40.77×60px / 3 行、“移除”约 42.31×56px / 2 行，只读链接也变成 2 行；手机出现 5 行链接。原始失败 JSON、截图与日志保留，不用既有任务工作台入口通过替代。

修复后定向 23 项单元通过；上述 10 场景初次全部通过。本地无运行 DB 的全量测试 464 文件 / 2443 项通过，63 文件 / 570 项按条件跳过；lint、全部 workspace 类型检查及构建通过。1180px 同一实际 Shell 内部附件行约 635px，查看链接 70×20px / 单行，移除 54×36px / 单行；390/360px 保持按钮既有手机尺寸，整组操作可移到下一行。数值仅为该合成样本的几何证据，不作为全系统固定尺寸或真人可用性结论。

## 回归范围与绑定

- `acceptance-three-fixes-browser.mjs` 使用实际 DigitalDesignerWorkspace、原内部路由、OrderDocumentContainer、工序工作台及 Shell；角色为非 Root 合成设计师。档案选择 → 本单资料 → 第3轮／轮次与记录 → 沿用第2轮车板只读任务 → 返回，核对 workspace/page/search/view/selected/development/round/documentChapter，刷新后轮次和章节仍在。覆盖 `/ui`、`/acceptance/ui`，1180/390px。
- 附件覆盖实际 Shell 内部编辑、只读、metadata 403 后重试、1180/390/360px。检查两操作各一行、长名省略与 Enter/Space 全文开合、原链接打开、合成原图固有尺寸800×650、移除仅改变本地草稿且无业务写请求。
- `bulk-board-containment-browser.mjs` 六视口 15卡／四栏不变；加入三张当前任务为空的特殊结案卡，其中一张兼有其他未满足条件。检查终态无“当前／待处理／负责人／截止”等待办暗示，原详情链接可激活；原取消、受阻、完成、超时及 PO 独立展开保持。开发看板几何与冻结基线保持；准备中/已完成详情仍可查原标识、版本、事实。
- 原来源 2路径×2视口×7 类和附件身份三视口各7类作为相关回归，防止设计师补入口及 DOM 分组覆盖原能力。

最终浏览器回归在本地 intended commit 冻结后、干净 checkout 上执行，`EXPECTED_HEAD_SHA` 明确约束；新结果 JSON 内保存 Head、tree、开始/结束时间、dirtyPaths 和产品 diff 摘要，新 Shell 驱动还逐场景保存时间及 pass/fail。只有初次开发结果带未提交改动，不将其冒充干净 Head 证据。原始证据目录为 `erp-handover/implementation/acceptance-three-fixes/`，最终固定 SHA/tree 和实绩见 PR 交付回执。

## 门禁与交付

使用 FULL：设计师合法复合来源涉及跨宿主关键返回链和安全校验，附件行由多个资料入口共用。按实际 diff 的风险映射决定是否执行 DB 阶段，不为纯 Web 修复追加无关 PG 施工。当前 Head Gate 全绿后请求一次 GitHub Codex Review，发现由本窗口核验修复，默认不追加第二次。

本轮没有连接真实 Acceptance／生产 API、数据库或订单。浏览器响应、角色和800×650图片均为合成拦截数据；触控为浏览器模拟，不冒充真实设备、屏读器或现场验收。原特殊结案分栏是否改变不在本次授权范围。

父窗口核验及用户授权合并后，再以实际合并的40位 SHA 沿原 `sudo /usr/local/bin/dx-acceptance update <MERGED_SHA>` 入口更新。没有新脚本或部署设计；本轮不执行更新，不用未合并 PR Head 冒充部署目标。
