# 样衣 PR-2：只读工作区

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 15b650ce3bff0a02e73a6941869498964283f08c
working branch: feat/sample-02-read-workspace
task scope: 样衣只读模块、导航、服务端分页与角色裁剪及五宽度 UI 验收
allowed files: apps/api/src/samples/sample-read*.ts; packages/contracts/src/sample-read.ts; packages/contracts/src/index.ts; apps/api/src/app.ts; apps/api/src/server.ts; apps/web/src/sample-*; apps/web/src/App.tsx; apps/web/src/components.tsx; apps/web/src/platform-modules.ts; apps/web/src/platform-home-page.tsx; scripts/run-business-chain-gate.mjs; tests/integration/sample-read-postgres.test.ts; tests/unit/sample-read.test.ts; tests/fixtures/sample-*; scripts/sample-ui-preview.mjs; docs/evidence/sample-02*
forbidden files: 既有业务状态机、认证实现、已有数据库迁移、依赖锁、治理门禁拓扑、生产数据
```

PR #405 已完成一次 Review、修正全部六项意见，第二次 Full Gate 成功并合并。远端 main 和合并树一致。仅对上述平台入口进行增量注册，原模块行为不变；回滚本 PR 撤下只读入口，保留 PR-1 数据表和源证据。

业务及 UI 标准分别采用样衣迁移规则与返工 UI Golden Source。页面复用 Shell、Header、Surface、StatusBadge、Button、返工表单类和唯一 ListPagination。新增 CSS 仅处理样衣字段布局和换行，不新建组件库、颜色或表单尺寸。

本 PR 不执行建档、借还、处置或生产导入；这些写路径依次在 PR-3 至 PR-5 实施。本阶段导航仅对具有样衣业务角色及能力的用户或 root 可见；移动入口位于更多。

## 已完成的本地验证

- 样衣基础及读取定向测试合计 27 项通过，包含所有业务角色导航允许/拒绝、未知查询/非法日期拒绝、HTTP 认证、参数化查询。
- 使用本地 PGlite 运行新增的 10 个 SQL 集成用例全部通过：31 件借出样衣跨三页不重复、越界页仍返回真实 total、采购财务裁剪、待确认按参与者与执行能力限制、处置业务日期边界、逻辑归档访问、历史分页及精确分项金额。
- 本地 SQL 验证不是 GitHub 真实 PostgreSQL 证据。当前 Head Full Gate 将使用原有 pg Pool 和隔离 PostgreSQL 执行同一集成测试。

## 浏览器验收缺项（经授权后置，尚未通过）

当前 Cloud Browser 拦截本地 HTTP 预览（ERR_BLOCKED_BY_CLIENT），随后明确以 URL security policy 拒绝本地 HTML 文件，并禁止绕过。因此没有生成或声称通过 375/393/430/768/1440px 截图及计算样式证据，不将构建和静态 CSS 检查冒充浏览器验收。

已提供独立、纯固定数据的复现入口，生产构建不会引用测试入口，也没有增加认证绕过：

```bash
node scripts/sample-ui-preview.mjs /path/to/new-preview-directory
```

生成的 index.html 使用实际 SampleWorkspacePage、Shell 和共享 CSS，在 iframe 中选择五种宽度及各角色/页面。该离线入口用于组件布局与交互验收，不替代真实认证和后端联调。

业务负责人随后明确指示“UI 先不用管，继续”：本次将浏览器验收后置，不作为当前 PR 合并阻塞；缺项如实保留。当前没有执行生产导入、角色指派或旧系统停写。

## 唯一一次 Review 后的修正

当前范围追加 `apps/api/migrations/0153_sample_read_indexes_snapshots.sql` 及迁移清单，全部为样衣增量索引与历史姓名快照。未修改既有迁移。

- 相关人员选项和筛选增加独立处置申请人。
- 编号/款号按开头匹配、不区分大小写；输入框明确提示。使用 upper 表达式 text_pattern_ops 索引，不增加数据库扩展或部署依赖。
- 处置日期增加匹配 COALESCE(paid_at,approved_at) 的索引。
- 申请人的姓名由样衣表插入触发器保存当时快照；操作事件通过仅匹配 sample 实体的追加触发器保存姓名，不改变其他模块事件。旧记录未留存的姓名明确标记，不冒充当时姓名。
- 新增人员改名/不可覆盖历史及 EXPLAIN 索引验证；SQL 集成用例增至 13 项，本地 PGlite 全部通过。读取与迁移清单定向测试 14 项通过。

Review 已使用一次，不再次触发；修正 Head 运行第二次 Full Gate，通过并处理完审查意见后按业务负责人授权合并。
