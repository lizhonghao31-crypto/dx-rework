# P01 总委派人员候选浮层

本增量基于 `release/digital-production-v1@7abe0545f43fda60dbe8bf403e76259e0ac29424`，对应统一方案 P01 / E10。只为总委派的 `SearchableSelect` 启用显式 `menuPortal`；原生 select 留在原表单，候选、岗位、API、数据库、保存命令与历史人员规则不变。其它宿主及管理座舱未启用。

浮层挂到 body，按可用视口空间向上或向下展开；自身滚动，不取消表格横向滚动。页面、祖先滚动与视口变化重定位；锚点离开视口或裁切祖先、原生控件失效时关闭。外部点击、失焦、Escape 关闭；中文输入法和键盘选择仍保留原生候选边界。

## 复现与检查

沿用仓库现有 Node 22、Chromium 与 Playwright，可执行：

```sh
node tests/acceptance/searchable-select-browser.mjs
node tests/acceptance/development-arrangement-browser.mjs
```

非默认安装可传 `PLAYWRIGHT_IMPORT`、`CHROMIUM_PATH`；证据输出分别使用 `SEARCH_EVIDENCE_DIR`、`ARRANGEMENT_EVIDENCE`。

- 默认 inline 模式：五种宽度，required、原生 FormData、合法值、禁用/候选收窄、键盘与原搜索组件。
- 专项浮层：四行合成总委派，前中末行逐项鼠标命中；35 名合成人员，自身滚动到底后正常鼠标选最后一项，不使用 force click 或预先 scrollIntoView；原生提交值、中文输入法、无匹配、停用候选、Tab/Escape、快速换行、祖先滚动、视口缩小及运行中禁用。
- 实际总委派组件配合合成 TEST 响应：核料成功自动跳转同单同轮、整批保存、回执丢失复读及主管接管既有行为，桌面/窄屏无文档溢出。该组件测试不代表真实 API 或现场业务验收。
- 专项的 1.25 是设备像素比例，不能称为浏览器菜单 125% 缩放验收。现场故障单/对照单、桌面浏览器真实缩放和触控设备仍待组间人工验收；不得保存真实订单来证明本增量。

## 堆叠 PR 门禁

本轮全部 PR 先施工、保持未合并。原 CI 只接受固定目标分支，后续 PR 指向前一个分支时不会触发。两个现有 Gate 因此只增加本轮 `unified-p*` 目标分支模式，保留 `[FULL]` 分流、事件 base/head 分类、最终 Head 校验、只读 contents 权限及无 secrets 边界；未启用部署、Preview 或 `pull_request_target`。不修改 draft 条件。

P01 指向 release；后续 PR 只包含相对前分支的自身增量。逐 PR Gate 与组累计候选验证分别记录。依赖修复、变基或改指 release 后旧 Gate 证据失效，必须按新 Head/base 重测；不能引用堆叠旧结果代替 release 合入检查。实际事件、run、Head 及 Review 记录在 PR 与交付台账，不在此预先声称通过。

无迁移。回退前端将恢复原行为和裁切风险，不需要且不得修改业务数据。
