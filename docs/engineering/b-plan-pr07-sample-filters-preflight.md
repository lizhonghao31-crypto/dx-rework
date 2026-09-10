# B方案 PR07：样衣分析筛选平铺

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 0f62e4c683c85b7364c8ffd0b07f42402a34591d
- working branch: work/b-plan-pr07-sample-filters
- scope: 合并原样衣分析筛选，去掉品牌等第二层折叠。
- allowed: sample-analysis-view.tsx、sample-analysis.css、执行文档。
- forbidden: 查询合同、金额、采购/借还/处置/回款逻辑、原办理表单、全局CSS。
- gate class: QUICK。纯局部UI，不追加Review。

12项筛选保持原字段、回调及采购/事件两套日期口径。桌面6列，逐级换至3/2/1列，按钮位于末尾。

验证：web TypeScript及改动文件ESLint通过；未改字段名/回调/查询合同，原12项筛选均保留。视觉待最终部署验收。
