# PR04 历史价格显示 Review 闭环

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: c5c8d78fca2e96477acd10086b0d38ae138bc9cb
working branch: fix/uat-v21-pr04-historical-price-closure
task scope: 原 PR04 #417 唯一 Review P2 PRRT_kwDOTpHFhc6f6GwI 的遗留闭环，不新增 PR14 需求。
allowed files: apps/web/src/sourcing-price-presentation.ts; apps/web/src/sourcing-workspace-page.tsx; tests/unit/sourcing-price-presentation.test.ts; docs/evidence/uat-v21-pr04-historical-price-closure.md; docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md
forbidden files: 其他业务、API/契约、写入验证、金额计算、历史迁移、合同、转厂/返工计价、CI/门禁及部署策略、生产数据。

已核验原 #417 在用户合并后仍有未解决 P2：历史批准价 1.2345 被财务行显示为1.23，不能解释原金额。仅将普通历史只读单价保留有效小数；单款普通摘要复用同一兼容显示，金额仍按原货币展示。现有新写入两位验证和转厂分支不动。

本补丁在 PR13 #426 门禁期间隔离准备；待 PR13 合并后再更新基线，保留其原入口追加改动。业务负责人已授权自行修复、Review 决策及合并；不重复触发原 PR04 Review。这个确定性格式修复拟不新增 Codex Review，以定向回归与最终 Head Full Gate 验证；Full最多2轮，无部署或生产数据操作。

## 验证

已将遗留修复重做在隔离基线上，未覆盖旧目录整份页面。5项定向回归通过，包含1234.5678保留四位、1.2300去无意义尾零、单款普通摘要1.2345保持精度、两位新写入限制、原金额计算与转厂既有契约；定向ESLint通过。财务逐款仅替换单价展示调用，批准行金额仍是原 formatBusinessCurrency，未修改数据。完整页面类型和构建由最终 Head Full Gate验证。

收尾核对：原 PR01 #414 图标 P2 代码已随 de31ce6cf4b7e5b35e6bce2f5b453a36fec82d29 通过用户授权的第三轮 Full34104546306 并合并；现行创建、列表/别名、加载详情、完整详情均保留显式 iconRoute。仅线程遗漏关闭，现已补充合并/核验事实并解决 PRRT_kwDOTpHFhc6f2ZFe，未新增 Review。PR02/03/05/06/07 检查无其余未解决线程；无线程不冒充 PR05/07 正式 Review 已返回。

随后读取到延迟返回的正式结果：PR05 bot 评论5570739933 对9b7fed5da6未发现重大问题；PR07评论5571708232对b44ce1dbc5未发现重大问题，均与各自最终合并Head一致。此处更新先前“未返回”的历史状态，不重复请求Review。

PR13 #426 已合并并核验 main c5c8d78fca2e96477acd10086b0d38ae138bc9cb。最终Head740a3b7cdef3ab54fc9a2e870f54d6e603658c01、第2轮Full34146869739成功，Quick按Full策略跳过，真实PG sourcing-pr03 17项通过；唯一Review三项均修复/解决。已重新读取最新main的外发页面，只重施两个显示调用改动，保留PR13分析入口；价格函数和测试未被PR13改变。
