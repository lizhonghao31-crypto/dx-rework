# 返工纠偏 PR1：列表恢复与流程样式

## 预检与范围

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 4af4f9d838675a98d60b1f1134af4ee2af830f0f（含 #550 预算价修复）
- working branch: fix/rework-ui-correction-pr1
- task scope: 撤回返工列表样式覆盖，详情沿用已验收外发流程视觉并删除节点冗余说明。
- allowed files: rework-detail-page.tsx、rework-governed.css、reporting/rework-query-page.tsx、reporting/basic-rework-board.tsx、三项现有页面契约测试、本记录与 UI Golden Source。
- forbidden files: API、数据库、合同及金额计算、权限与状态机、共享 UI 样式、其他模块、创建页及各业务办理表单、历史节点数据实现。
- gate class: FULL（用户明确要求）

## 已确认根因与修复

1. #549 给列表增加 governed 作用域；其 dl 的 display:grid 覆盖原 display:contents，与原外层多列 grid 叠加，导致指标挤进一列。撤销两个列表入口的 scope/import，并删除详情样式中的全部列表覆盖。
2. 返工使用另写的节点样式，未来节点颜色引用未定义变量。改用外发正在使用的 WorkflowRail，继承同一套勾选、圆点、连线、状态色。仅针对九节点设置桌面五列换行及行首尾连线；手机默认折叠，展开后横向查看。
3. 节点只保留名称、负责角色及状态；删除等待某人提交等长说明和不再使用的阶段折叠呈现。原节点链接、权限、未来节点预览与当前办理区均保留。
4. 图片与流程使用相同标题行高度、行高、外边距，流程标题取消多余包装，补图按钮仍紧邻图片标题。

## 验证事实

- 定向四文件 20 项测试通过，覆盖节点/工作区路径、列表作用域隔离、手机折叠与图片查看契约。
- Web TypeScript 检查、定向 ESLint、生产构建通过。
- 没有浏览器截图验证证据；上述结果不代表视觉验收通过。部署由用户执行。
- GitHub Full Gate 及 Review 结果以 PR 当前 Head 为准。

## 下一 PR 的独立范围

历史节点完整原页面只读还原、工人工序明细、IE 核对内容、数字格式及重复标题在 PR2 修复，本 PR 不宣称解决这些问题。停止向其他模块扩展。

- 首轮 Full Gate：1743 项通过，1 项旧测试仍要求已删除的阶段折叠结构；已将该断言改为使用 WorkflowRail，保留原办理组件检查，业务代码没有追加修改。

- 一次独立 Review 发现 P2：手机展开时仅查找 is-current，已完成订单末节点不会自动滚入视野。已改为按实际活动节点的 data-active 定位，完成订单以 N09 为回看定位，并在数据刷新后同步；只影响展示定位。相关五文件 36 项检查通过，修复后重跑 Full Gate，不发起第二次 Review。
