# ERP 体验 PR01：开发草稿品类保存与重开

目标分支：`release/digital-production-v1`；基线：`0e198f0989050d7fd7a400b7a6a9453bde71cbfd`。对应整体方案 V3-001。Gate：FULL，涉及开发草稿的数据契约与打板品类选择；最终 Head Gate 全绿后请求一次 GitHub Codex Review。

原表单把品类和当前价格版本只放在临时控件状态中，草稿保存和未保存比较都没有品类。只改品类保存后重开会回到“请选择”，离开也没有未保存提示。本次将品类选择纳入现有草稿文档；价格仍按当前有效报价读取，发布继续通过原 `patternOrder.categoryId/priceVersion` 校验，不把草稿选择作为工资或历史价格快照。

| 环节 | 字段与行为 |
|---|---|
| 控件 | `DevelopmentPatternLink.selectedCategoryId` 来自草稿，确认切换后经 `onCategoryChange` 写回文档；取消不改值或尺寸 |
| 保存请求 | 原 `PUT /digital-production/sources/:sourceId/development`，仍带 `expectedVersion` 和幂等键；新增 `document.patternCategoryId`，可空、可缺，非空须 UUID |
| 存储与读取 | 原 `digital_development_documents.document` JSONB 原样保存/读取；无数据库 migration、历史回填或新端点 |
| 重开 | 从同一文档字段回填品类，再经原 quote 接口取得当前金额和版本；不存草稿金额或报价版本 |
| 未保存保护 | 品类属于 `document`，自然进入原 `draftSnapshot`；成功保存后更新原基准，失败保留 dirty 和输入 |
| 正式发布 | 原发布校验和价格版本锁定保持；没有有效当前 quote 时，现有 `patternChoice` 仍为空 |

权限、Root 特殊能力、已发布资料不可覆盖、乐观版本校验、任务生成、尺寸模板和工资规则均沿原实现。品类选择不是有效价格承诺，也不让草稿产生打板任务。

| 断言 | 验证方式及结果 |
|---|---|
| 字段通过真实保存契约写入并由新服务实例重读；允许清空、兼容缺字段 | `digital-development-postgres.test.ts` 新增用例，专用临时 PostgreSQL，PASS |
| 他人无权覆盖草稿，保存不创建任务，非法 ID/任意价格字段拒绝 | 同一隔离 PostgreSQL/契约用例，PASS；原权限服务未改 |
| 单改品类触发返回列表及内部导航确认；取消保留、保存后返回不再提示 | 实际 `DevelopmentCreateForm` + 合成拦截响应，1440×900 与 390×844，PASS |
| 保存、重开及当前价格读取；切换取消/确认保留 M60；保存失败/重试 | 同一组件浏览器回归，PASS；三 PO、日期、数量、说明保持 |
| 报价刷新失败不会制造用户未保存修改或错误保存回执 | 同一组件浏览器回归，PASS |
| 现有发布、报价版本和集成链 | 相关既有单元/集成检查与本 PR 当前 Head FULL Gate 分别记录；不能由样板或本地浏览器推定 |

复现命令：先 `npm run build:packages`，设置已通过 `scripts/test-database-safety.mjs` 的显式 `TEST_DATABASE_URL` 后运行 `npx vitest run tests/integration/digital-development-postgres.test.ts`。浏览器回归用 `PLAYWRIGHT_IMPORT=<已安装模块> CHROMIUM_PATH=<浏览器> node tests/acceptance/development-draft-pattern-browser.mjs`；可用 `DEVELOPMENT_DRAFT_EVIDENCE` 保存截图和结果。

本地浏览器挂载实际产品组件；所有 API 响应由合成 fixture 拦截，无外部业务请求。它证明本 PR 的组件行为，不代表整页视觉/真人/真机验收。隔离数据库只运行本地 TEST 数据，不连接生产或 Acceptance。部署后的合法账号、原来源返回、同一草稿保存重开及正式发布接力仍为 `POST_DEPLOY_PENDING`，只可在对应候选版本获授权部署后验证。本 PR 不自行合并或部署。

兼容与撤回：旧草稿缺字段仍可读取保存，不修改已发布文档。若撤回界面变动，需保留新可选字段的读取/保存契约，使用最小兼容前滚；已保存 JSON 中可能含该字段，不能直接降回旧 `.strict()` 契约后继续提交这些文档。不得为撤回而清理真实草稿或历史数据。
