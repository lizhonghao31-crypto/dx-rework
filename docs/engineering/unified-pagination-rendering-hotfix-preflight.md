# 全站分页展示收口热修预检

repository: lizhonghao31-crypto/dx-rework  
base branch: main  
base SHA: 1ee42b82ee879e9c1a24b26716219b4b53ada413  
working branch: fix/unified-pagination-rendering-hotfix  
task scope: 修复全站分页被侧栏 nav 样式纵向覆盖，并让普通分页与游标分页共用“我的待办”数字页码展示  
allowed files: apps/web/src/styles.css、apps/web/src/rework-workbench.css、apps/web/src/list-pagination.tsx、apps/web/src/list-pagination.css、对应分页单测、本预检文档  
forbidden files: my-todos-page.tsx、my-todos.css、API、contracts、数据库、权限、业务状态机、金额数量逻辑、部署与 GitHub Actions  

## Golden Source 与根因

- `apps/web/src/my-todos-page.tsx` 和 `apps/web/src/my-todos.css` 保持不变，继续作为分页 DOM 与视觉金标准。
- `.app-shell nav` 错把主内容区分页当作侧栏导航，且选择器优先级高于分页类，导致页码按 grid 纵向排列。
- `body .app-shell nav` 又把侧栏滚动尺寸施加到分页，继续造成不同页面的高度、内边距与滚动行为不一致。
- 普通列表与游标列表此前各自渲染数字和箭头两套 DOM，违反单一展示模板要求。

## 收口规则

- 每页仍为 15 条；筛选、搜索和视图切换后的重置逻辑保持不变。
- 有总页数的列表继续显示五页数字窗口。
- 仅有游标的列表不伪造总页数，只显示当前可到达的相邻数字页码。
- 空结果和单页继续显示当前数字页码。
- 不改变 API、数据含义、权限、业务状态或统计口径。

## 验收与回滚

- 自动化必须锁定侧栏选择器作用域、唯一分页视图、桌面 34px 与移动 32px 金标准，并禁止箭头字符回归。
- UI 变更需在部署后分别以桌面端和移动端核验“我的待办、订单回货、返工单看板、工资管理”。
- 回滚方式：回退本 PR；无数据库、接口或业务数据迁移。
