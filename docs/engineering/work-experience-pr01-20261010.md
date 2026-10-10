# PR01 公共控件与作业文案

开发单的表格输入样式同时作用于复选框，导致勾选项受到 60px 最小宽度约束；日期展示文字还使用固定顶部偏移，不能适配 30px 表格控件与 44px 移动控件。本次限制表格规则的适用输入类型，按实际控件高度对齐日期，并补齐现有公共字段的必填、选填、错误关联及只读状态。

## 施工基线

- 仓库：`lizhonghao31-crypto/dx-rework`。
- 目标分支：`release/digital-production-v1`；base SHA：`09fbd674bf5140907774354e624f336f2cbb2a95`。
- 同次远端 main：`6dc22c5359833daf18887064d5bd13288517d344`；main 独有 39 提交，集成分支独有 191 提交；开放 PR 查询为空。
- main 迁移清单 223 项，集成分支 246 项；前 218 项完全相同，此后的历史不能直接混合。本 PR 沿用集成分支清单。
- 工作分支：`feat/work-experience-pr01`；Gate：FULL，共享 UI。
- 修改范围：现有 UI 字段/按钮、数字单据与板房相关 CSS、活跃显示文案和对应单元测试。
- 运行版本：Acceptance 版本端点读取返回 HTTP 403，实际 API、前端与 schema 未在此环境验证；父窗口提供的候选指向信息不能视为现场健康证据。
- 本 checkout 未发现 `.agents/skills`；已读取根 `AGENTS.md`、Work 施工纪律、Actions 使用规则、UI Golden Source 和 Acceptance runbook。

## 控件盘点

| 控件 | 实际引用一 | 实际引用二 | 已有行为与本次处理 |
|---|---|---|---|
| 普通按钮 | `digital-development-panel.tsx` | `pattern-order-form.tsx` | 已用 inline-flex 双向居中；明确 border-box，保留已有尺寸和各页面变体 |
| 公共单行输入 | `inspection-report-form.tsx` | `reporting/rework-query-page.tsx` | 现有 inset 容器已垂直居中；输入允许缩小，避免后缀挤出；必填/选填只按显式 props 显示 |
| 单据数值输入 | `digital-development-panel.tsx` | `digital-budget-panel.tsx` | 原文档字段保留数值字符串和精度，仅对 decimal 输入做右对齐及等宽数字 |
| 日期输入 | `digital-development-panel.tsx` | `production-instruction-panel.tsx` | 表格使用 30px，窄屏 44px；叠层文字按高度居中，空值显示“请选择日期”；原日期字段不改 |
| 复选项 | 开发单面辅料表 | 开发单唛类区 | 通用表格 input 最小宽度误及 checkbox；排除 checkbox/radio，勾选项保留桌面 16px、窄屏 20px 和 label 点击 |
| 字段错误 | 公共 `InsetField` | 单据 `DocumentField` | 为公共字段补完整 aria-describedby/aria-invalid，保留已有说明；单据继续用既有字段定位和错误区域 |
| 多行/只读资料 | 开发单制作说明 | 制单正文 | 保持顶部阅读及历史版本；本次对单行日期与数值的规则不作用于 textarea |

## 作业用语

数字任务显示“等待前置”“暂时办不了”“报告问题”“恢复办理”，对应原任务状态和原反馈接口。洗水选择显示“本厂洗/外厂洗”，提交值仍为原来的“内洗/外洗”。核对面辅料提交按钮显示“提交面辅料核对结果”，准确涵盖通过和缺项退回两种提交。

当前 PR 建立显示映射与控件基座。岗位工作区和导航直达由 PR03/PR10 实现；各业务模块文案随对应 PR 对照实际动作应用，不把旧中转按钮换名冒充已经可直接办理。

## 本地检查与实际限制

- Node 22.22.2 / npm 10.9.9；使用仓库 lockfile 安装依赖。
- 9 项公共字段/按钮/旧打板定向检查通过。
- 完整测试：430 文件通过、61 文件跳过；2172 项通过、523 项跳过。跳过项不是已通过的数据库或现场业务验收。
- 全仓 lint、类型检查及全部工作区构建通过；迁移静态校验、Actions 门禁规则和工作树 secret scan 通过。
- 浏览器控件检查：复用本环境已有 `/usr/bin/chromium`，通过标准 loopback HTTP 加载实际 React 公共组件与源 CSS 的状态样例。1536×960、1440×900、1280×800、390×844 及 1536×960 CSS zoom 1.25 五组均通过：按钮居中、复选框标签点击和尺寸、日期文字居中、数值右对齐且保留 `123.456`、错误关联及空日期提示。CSS zoom 是局部缩放检查，不等同于浏览器菜单 125% 缩放验收。
- 视觉证据：本地 `/workspace/pr01-evidence/` 保留状态样例、可重放脚本、五组截图和 `metrics.json`；已查看桌面与窄屏截图。它们用于控件检查，不代表真实业务数据或岗位现场验收。
- 新浏览器下载曾被官方域名 `cdn.playwright.dev`、`playwright.download.prss.microsoft.com` 的 `403 Domain forbidden` 阻断，已停止下载；现有浏览器的复用解除本地视觉检查阻塞。
- 普通岗位在线接力与视觉验收：未运行。没有将本地组件检查或 root 身份等同于普通岗位现场验收。

图片只作为结构与操作位置参考，示例数量、价格、名称和旧文案不能覆盖施工 MD 正文与业务 Golden Source。
