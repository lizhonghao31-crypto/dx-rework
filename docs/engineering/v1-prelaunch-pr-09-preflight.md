# 上线前 1.0 PR-09 施工预检：移动工作区紧凑化

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `e94b63f97801a26a112183c8777d8f1cb5c3618e`
- branch: `feat/v1-prelaunch-mobile-workspace-density`
- objective: 去掉责任供应商自动带入后的占高说明；将返工详情状态并入 RW 单号行；移动端图片/流程仅保留一套折叠标题并消除空白；“临时工系数”更名为“临时工工资调整”且整个区域默认折叠。
- allowed files: `apps/web/src/components.tsx`; `apps/web/src/styles.css`; `apps/web/src/rework-detail-page.tsx`; `apps/web/src/rework-detail-compact.css`; `apps/web/src/responsibility-determination-panel.tsx`; `apps/web/src/responsibility-determination.css`; `apps/web/src/whole-order-review-panel.tsx`; directly affected unit tests; 本预检记录
- forbidden files: `apps/api/**`; `apps/api/migrations/**`; `packages/contracts/**`; `packages/domain/**`; 责任自动带入逻辑；数量、工资与责任计算；权限；钉钉；部署配置；生产数据
- verification: 定向 UI 契约测试、web lint/typecheck/build、全量精确 PR Head CI；移动端以单行折叠标题、工作区首屏上移为验收重点
- rollout boundary: 本 PR 不改变业务状态机或提交条件，不主动部署生产。

## UI 验收口径

1. 责任供应商仍自动带入，但不再显示“已带入订单加工厂，可重新选择”等说明，不增加责任行高度。
2. 返工状态徽标与 `RW-...` 同行；不再单独占一行。
3. 移动端“订单图片”和“订单流程”各只出现一次；折叠时卡片内只有一行标题、摘要与展开按钮，隐藏节点不保留 padding、边框或空白。
4. “临时工工资调整”整个区域初始折叠；展开后仍按工序分组，原倍率校验、原因必填和提交条件不变。
