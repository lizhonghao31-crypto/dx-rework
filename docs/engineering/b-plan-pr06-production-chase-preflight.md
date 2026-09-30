# B方案 PR06：生产追单与行内排除

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 1e38c549af6fb97e06ee3a09c3a5af9b05175bc3（PR05 #460，Full Gate 34467702349 成功）
- working branch: work/b-plan-pr06-production-chase
- scope: 原生产看板摘要和追单信息、Root行内删除复用原排除链、低频工具收进管理入口。
- allowed: production-dashboard 只读服务/合约与局部UI、原排除控件接收当前订单ID、定向测试及文档。
- forbidden: 原排除写入/审计/权限逻辑、生产数量修正及正式取消、ERP、全局CSS。
- gate class: FULL。

剩余工作日沿用周一至周五并包含今天/交期。所需日均向上取整；没有交期或工作日不算。近期比较使用最近7自然日内最近3个有有效上报的生产日，按同日合计并应用修正，未报数不补0。样本不足明确不判断；仅对未完订单比较。供应商集中只统计当前权限可见的本公司未完订单，不推断供应商整体产能。

## 验证

contracts/API/web TypeScript、定向 ESLint 通过。生产进度/筛选/Root排除与刷新策略共40项通过；PGlite生产分析及有效报数修正8项通过。新增只读追单口径，Root入口沿用已验证的排除服务，未修改角色权限、审计或写入链，按用户实用优先要求不追加可选 Review。视觉与真实办理留最终部署验收。
