# B方案 PR10：全系统框与分析区域审查

日期：2026-09-10。仓库：lizhonghao31-crypto/dx-rework。分支：work/b-plan-pr10-system-ui-closeout。Gate：QUICK。基线 main SHA：39a2b61cdb8e9cfd44190b4b5161923d233065eb。

审查依据为当前源码、前序 PR 的实测结果和最新用户决定。逐页检查分析/筛选/入口的职责、对象、处理角色、下钻与刷新；不声称完成登录后的逐页视觉 UAT。

| 页面 / 区域 | 结论 | 业务价值、处理人与动作 | 本轮结果与源码依据 |
|---|---|---|---|
| 我的待办 | 保留 | 模块数量帮助本人决定先办哪类事项；卡片进入已有任务，受阻项说明转交 | 单一模块栏、搜索、15项分页已存在，无新增分析框；`apps/web/src/my-todos-page.tsx` |
| 订单回货 | 合并、深化 | 仓管/对应处理人从当前收货、装箱差异或缺单筛选进入原“去处理”，照片及旧结果可回查 | PR01/PR05 已合并原状态筛选和异常统计，撤下独立分析块；`apps/web/src/order-board-page.tsx` 与共享 `receiving-board-filters.ts` |
| 返工看板 | 深化、合并 | 管理/原办理角色按节点等待、往返和缺记录找到原单 | PR04 已接真实发起/处理人及历史；PR10 去掉分析里重复的关键词/节点输入，把入口放到主筛选之后，保留分析专用维度；`rework-flow-panel.tsx`、`reporting/rework-query-page.tsx` |
| 返工详情 | 保留、移位 | 当前办理区负责执行；责任结果说明当前版本及历史已扣，正式角色可带原因重判 | PR08 新版本/签字/已扣衔接；PR09 手机办理区优先，照片与流程沿用折叠，责任点击编辑；`rework-detail-page.tsx`、`order-responsibility-revision-panel.tsx` |
| 外发定价与选厂 | 保留 | 管理/IE/老板对照不同版本的初始外部价、IE价和批准价，链接回原外发单 | 报价对照有独立版本事实，保留折叠入口及自己的记录范围；不把差价叫利润/节约，不改五节点表单；`sourcing-workspace-page.tsx`、`work-analysis-panel.tsx` |
| 实时生产 | 合并、深化、移位 | 跟单/生产管理查看集中度、日需求与实际产量，点击压力筛选后进入原单追进度 | PR06 撤下独立分析块，融入摘要和原行；Root 行内删除仍走原预览确认，低频管理放工具入口；`production-dashboard-page.tsx`、`sourcing/production-chase.ts` |
| 供应商中心 | 保留、分离、深化 | 目录用于选择，维护页用于补资料；维护角色批量识别已有对象并补空 | PR02/PR03 完成职责分离和识别补全；供应商详情的在产分析有明确供应商范围，可进入原生产单，予以保留；`supplier-center-page.tsx`、`supplier-batch-panel.tsx`、`production-analysis-panel.tsx` |
| 样衣管理 / 分析 | 保留、合并 | 样衣管理角色从统一筛选看到采购/处置及原样衣明细；回到原借还/处置流程 | PR07 去掉第二层品牌等筛选折叠，保留两类日期定义、趋势下钻、明细分页和历史口径说明；`sample-analysis-view.tsx`、`sample-workflow-page.tsx` |
| 工资 | 保留 | 财务/有权管理者按期间、工人和单号核对工资，逐单逐人明细及导出支撑复核 | 汇总随主筛选，明细截断已有明确提示；不调整工资算法、月结或锁定；`wages/wage-period-list.tsx`、`wage-period-detail.tsx` |
| 责任 / 扣款队列 | 合并、删除重复框 | 处理人按队列进入原责任与扣款办理，当前金额/余款仍在具体任务上 | PR10 将重复“工作台”介绍并入已有标题说明，去掉无独立数据的两块介绍卡，同时消除旧 N06 标签；保留搜索、卡片、分页与所有操作；`responsibility-queue-page.tsx`、`external-responsibility-queue-page.tsx` |
| 系统管理 / 技术诊断 | 保留、移位 | 管理/技术角色按阶段、结果和请求记录定位问题；原审计筛选可核查实体及请求 | 已位于管理区折叠入口，明确历史缺失和无因果关联；不将诊断成功率当业务绩效；`admin-console-page.tsx`、`work-analysis-panel.tsx` |

## 保留为后续独立事项

- 报价、诊断与供应商详情里的历史分析有独立筛选口径，不与业务列表假装同一统计。若将来统一为同一数据集，需要单独设计，不能在 UI 收口中改查询规则。
- 工资按工人汇总对当前加载明细的覆盖限制已有提示；不在本轮改工资报表接口或扩展全量查询。
- 真实手机、软键盘、深色导航与实际权限账号的视觉/交互验收留在最终部署验收，不以源码检查代替。

## 长期规则

新增 `docs/requirements/business-analysis-limited-ui-golden-source-v1.0.md` 并由 AGENTS.md 引用，固定分析五问、可下钻、失败隔离、主筛选唯一、原工作区保护、折叠边界、间距和移动端规则。

本 PR 只处理上述分析入口、重复介绍框和规则文档。无 API、migration、权限、金额或既有办理函数变更，不追加可选独立 Review。

## 本地验证

web TypeScript、改动文件 ESLint 与相关导航 10 项测试通过；生产构建通过。前序财务和数据库验证以 PR08 独立 Gate 为准；PR10 不重复增加数据库施工。
