# ERP体验PR05：来源返回与页面上下文

目标release/digital-production-v1，基线`0e198f0989050d7fd7a400b7a6a9453bde71cbfd`。主题002/006/008/013/028/032的来源与上下文部分；035只做通用切页回归，不认定根因或单独修复。FULL Gate，首次Head通过后已执行一次必要GitHub Codex Review；修复后重建新Head Gate并交父核diff，不增加Review次数。无业务API/字段/权限/状态机、统计或工资变更，不合并、不部署，不操作真实生产/Acceptance。

原机制只在workspace参数存在时传递座舱来源，普通筛选座舱及详情二次下钻会丢上下文；开发沿用记录是裸task链接；任务页签/资料类别和章节只在内存；裁床原返回解析拒绝bulk来源；预算进外发没有数字来源，外发历史详情的Shell固定选待审批。实际390px回归还确认原返回动作被既有CSS隐藏。

| 改动 | 保留及恢复契约 |
|---|---|
| 数字详情来源 | 验证同源本地工作台或原详情，携带原对象、版本、筛选、页码和允许的显示上下文；最多有限父链，拒绝外站、反斜线、hash、重复/未知参数、非法ID/版本、循环；根路径和带前缀路径只加一次base |
| 任务与资料 | 页签、类别、章节及已选阅读版本写入显示查询参数，不存业务输入/文件/角色。返回后重新读取；任务及其原资料仍经原权限/当前轮与历史模式。沿用记录明确taskView=read；保留router history.state和原离开检查 |
| 大货到裁床 | 原裁床返回精确bulk对象/PO行，再回原筛选工作台；行首次恢复滚动/聚焦，随后刷新不抢焦点；没有新增实裁门槛或写接口 |
| 预算到外发 | 原发起/查看入口携合法数字来源；创建页可返回该来源，成功创建的原导航通过同一验证器传给外发详情。原prepare-sourcing、正式提交及鉴权保持 |
| 外发历史 | 有效history列表来源同时驱动Shell和移动选中态；无效/歧义来源安全回退。窄屏恢复已有返回动作显示，未加第二套按钮，不改摘要字段、审批或布局规则 |

产品私有显示工具为digital-detail-context.ts；来源构造从journey模型移到已有digital-detail-route，原调用者一起接续，没有新增路由平台或缓存/keep-alive。未知返回丢弃而非跳到外站；业务数据始终重新读取，URL上下文不授予权限。

验证：四文件50项定向单元；真实DigitalProductionPage/任务与资料、BulkPreparationPanel、CuttingDetailPage、预算与SourcingWorkspacePage，加原内部路由，在1440×900和390×844、根路径和/acceptance/本地前缀共四组，各7类检查通过，0页面异常/外部请求。覆盖沿用记录只读→返回任务资料章节并重新读取、已采用预算类别/版本/章节与历史页签重挂载、裁床→指定PO→筛选来源、当前预算→外发创建入口→原预算、外发历史桌面/移动高亮及返回。前缀只是隔离HTTP路径，不是实际Acceptance。

反例：同一fixture加载固定基线的任务/开发组件，切入资料后地址没有taskTab=documents而失败；窄屏既有CSS隐藏原返回动作也在实际组件回归中失败，修后通过。来源列表在fixture中是占位宿主，只证明返回URL身份，不冒称完整列表UI通过；外发创建入口/返回实际执行，正式创建成功后的返回适配由单元验证，不声称已执行真实或完整创建链。

与冻结PR04 Head1782b7b8的工作台，用临时副本三方合成验证无文本冲突，原结果未确认保护及本次上下文均保留；再以原PR04实际组件/合成响应双视口11类回归核组合，未改变任何实际分支或PR04文件。该证据不等于已合并/已部署。

命令：`npx vitest run tests/unit/digital-source-navigation.test.ts tests/unit/digital-detail-route.test.ts tests/unit/cutting-ui-contract.test.ts tests/unit/sourcing-list-query.test.ts`；安装已有Chromium/Playwright后`node tests/acceptance/digital-source-context-browser.mjs`，SOURCE_CONTEXT_EVIDENCE可保存证据，SOURCE_CONTEXT_BASELINE=1加载上述固定旧组件反例。另完成实际改动ESLint、Web类型/构建、secret scan和diff检查；本地全量458文件、2387项通过，62文件/562项按无运行数据库条件跳过，未冒称数据库依赖已执行。精确Gate随当前Head记录。

回退只撤显示查询参数、来源构造与原按钮可见性，不撤销任何业务事实。真实账号跨岗位接力、当前部署构建/权限与自然故障仍是POST_DEPLOY_PENDING；源历史M01/D06不因导航修复获得归因。


一次Review在原Head d42077dd指出两个P2，均已按实际反例核实。合法development+round+task来源沿digitalDetailRoute原优先级辨认活动详情，保留合法原生复合上下文；所有出现的ID/版本仍分别验证，外站、歧义、非法ID及循环仍拒绝。旧Head实际返回跳过开发详情，根路径/前缀单元和实际页面均复现失败。

三个原版本选择器经原离开/写入保护后，回传选择到资料容器；容器保存对应阅读kind与各文档版本，辅助类别/切页/重开保持该事实。任务显示上下文用受验证的current字面值区分明确选择“当前资料”与默认采用快照；活动文档路由的历史版本仍只接受正整数，不改变业务轮次/发布或权限。旧Head把开发历史第1轮改回第2轮的实际反例已复现；修后开发、制单、预算历史及已有当前选项均通过辅助类别与重挂载回归。

新增制单选择器回调与冻结PR04的制单回执在临时副本合成无文本冲突；组合后的来源/版本四组各7类、原回执/离开保护两视口各11类通过，0异常/外部请求。修后本地全量2387项通过/562条件跳过。SOURCE_CONTEXT_REVIEW_BASELINE=1可加载固定原审查Head复现，SOURCE_CONTEXT_REVIEW_ONLY=compound或versions可定向；当前Head Gate与父核diff另记。
