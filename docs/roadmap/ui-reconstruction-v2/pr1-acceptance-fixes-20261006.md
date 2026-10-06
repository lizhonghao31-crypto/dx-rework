# PR1 上线验收修复（2026-10-06）

## 基线与范围

- repository: lizhonghao31-crypto/dx-rework
- main: cdabead9d4832bdb86540bcffd32ca880b04f890（只核对，不合入）
- base: release/digital-production-v1，fde52e602ce53e2d9bcd8d9bee1a8ec6a3d4eb69
- branch: fix/v2-pr1-acceptance
- 当前业务负责人授权：PR1 验收问题修复、本地必要验证、仓库 Gate、合并 release；部署由业务负责人执行。
- Gate: FULL。涉及 Journey 到原任务的关键下钻、历史只读意图和既有审计更正入口，按 AGENTS.md 第 7 节分类；冻结候选后仅请求一次 Codex Review。
- 允许范围：Journey 查询/展示、原任务详情适配、配套契约和定向测试。
- 禁止范围：迁移、线上订单/数据、ECS、部署工具、scripts/infra/package、后续模块并行施工。

## 验收发现与实现

| 发现 | 实现与边界 |
| --- | --- |
| 大阶段完整时间秒数换行越界 | 日期和时分秒分为两个不拆分的行，在原卡片内对齐；保持秒精度和七流程、原三列区域。 |
| 交期和整单已完成 KPI 越界 | 日期/状态卡使用适配文本字号；不省略事实文字、不改变指标口径。 |
| 原任务紧凑详情没有订单身份 | 后端从任务可信父资源取得款号、客户；另核验父资源技术读取权限。不采信 returnTo.selected，不授权读取额外资料。显示任务真实轮次。 |
| 操作和改派记录显示 UUID | 只解析已授权 Journey 节点引用的人员 ID，补充姓名；ID 保留在契约，改派 ID 可由提示查看。没有读取全员目录。 |
| 历史只读入口暴露时间更正表单 | 原记录 mode 传入 taskView；只读界面不显示写表单，写入处理器也拒绝提交。主管主动进入“时间核实”独立入口后，仅允许当前任务时间更正；原普通入口及服务端权限不变。该问题原先只证实 UI 意图丢失，未证明后端越权。 |
| 本地追加发现：拒绝访问提示藏在折叠内容内 | 紧凑详情和错误状态展开显示，让服务端 404/拒绝提示可见；不改变拒绝规则。 |

## 定向验证

- 17 项 Journey 单元测试通过：原返回上下文、日期语义、节点事实、只读写入保护和独立核实路径。
- 26 项真实 PostgreSQL 集成测试通过：Journey 与原任务、范围拒绝、身份缺失而非扩权、改派姓名、原审计/状态/时效行为。测试仅使用临时自有 schema。
- 全工作区 lint、typecheck、build 和 secret scan 通过；最后任务面板微调再次执行相关 lint/typecheck。
- 浏览器脚本：tests/acceptance/v2-pr1-acceptance-fixes.mjs。使用本地隔离 TEST 库、真实登录和查询，无 API 拦截。覆盖人员姓名、历史只读、篡改返回选择不串身份、主管独立核实、原普通入口、无权任务拒绝、固定视口卡片与三列位置。
- 长日期/整单完成和所有时间同时出现，另用正式生产组件的固定显示快照做压力对照，明确不视为真实完整业务 UAT。
- 每次浏览器结果记录 SHA、dirty、实际请求、几何边界和错误；最终截图须对应最终干净 HEAD。
- 已安装工具基线 42b2a947 原 verify-tool-refresh.py 对实际候选目录通过：238 条迁移。旧 acceptance-update-policy.mjs 校验安装版迁移历史与候选 compatible，pending=[]。Python 使用 -B，不在受保护目录生成 bytecode。
- 受保护 scripts、infra、根 package/lock、迁移 SQL/manifest 相对 fde52 无差异。

## 证据边界

GitHub Gate/Review、最终 HEAD、截图与合并 SHA 由最终 PR 评论补充，本文不预先宣称它们完成。未部署、未执行修复后线上复验、未执行完整岗位接力或移动端验收。旧 A4 板房任务元数据与仓库待办缺陷未在本 PR 修复；不宣称完整 UAT 通过。
