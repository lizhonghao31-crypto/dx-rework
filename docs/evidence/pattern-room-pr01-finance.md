# 订单打板/财务中心 PR01 接手与验收记录

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: ace63ce8d84058b34fb77a95d10c4ba60775f6bc
working branch: feat/pattern-room-pr01-finance
task scope: 财务中心入口与唯一工资管理的查看、导出、结清权限收口
gate class: FULL

开工已核验远端 main 与需求快照一致，当前无开放 PR。本地源文件内容已按远端 Git tree 的 blob SHA 核对。远端提交基于上述真实 main tree，只提交本 PR 修改文件。

## 范围与约束

允许文件：财务入口/导航/授权，现有工资及报表路由和服务授权，新增 0174 迁移与 manifest，共享财务角色常量，相关验收矩阵与测试、业务需求和本记录。
禁止修改：旧工资金额算法、返工状态机、旧迁移文件、收货/供应商/外发/样衣业务、CI 拓扑、Root 权限机制及生产数据。

- 新增 /ui/finance 二级入口，进入后点击工资管理；旧 /ui/wages 及历史详情继续有效。
- 查看与工资导出仅 Root、老板、生产管理、财务总监、现有工资财务角色（wage_month_close_accountant、finance_read）。
- 标记结清仅 Root、财务总监及上述工资财务角色；多角色按实际有效授权合并。
- 数据库再次验证有效身份、持久化角色与能力；旧委派工资能力也不能扩大角色白名单。
- 不修改任何已有工资或结清记录；不开放板房业务或增加付款/锁定/审批功能。
- 对应 A01–A06、A51–A52；历史工资、完整筛选和结清回归保持原金额断言。
- Codex 一次 Review 指出共享看板/查询仍含工资金额（P1）；修复覆盖现场与管理看板、岗位订单列表、返工总览预览/导出。无权字段省略，非工资业务保留；有效数据库角色撤销后同样隐藏，Root 保留。增加真实 HTTP → Service → 序列化/XLSX 回归及完整数据库链允许/拒绝断言。

## 实际验证

本地 Node v24.19.0；项目锁定依赖已从已有缓存及相同版本 npm 包恢复，未修改锁文件。远端 Full Gate 按仓库标准 Node22/npm10 执行。

- npm run typecheck、npm run lint、npm run build --workspaces --if-present。
- npm test（无 TEST_DATABASE_URL 的标准套件，数据库专用测试依原有条件跳过）。
- npm run db:migrate:lint、npm run secret:scan、git diff --check。
- finance-wage-access 单元/HTTP 允许与拒绝、旧地址/历史详情/报表导出/结清、多角色与零普通角色 Root。
- 本地 PGlite 执行 finance-wage-access-postgres 与 wage-settlement-postgres：6 项通过，覆盖持久化角色/委派、原工资与结清保留、502 条完整范围、同名分人、重复标记和后增明细。
- 本地 PGlite 回放完整迁移并执行 full-business-chain-postgres 的 N01–N11 正常全链：1 项通过。用财务角色读取原工资，并增加尾部主管拒绝读取断言。PGlite 是本地补充验证，远端 PostgreSQL16 门禁单独执行。

浏览器视觉与现场钉钉未验证：Cloud Browser 请求本地预览被 ERR_BLOCKED_BY_CLIENT 阻断，本地 Vite 亦报告网络接口枚举权限错误。未将静态检查当成浏览器验收。未连接生产、未生成生产测试订单。

## 发布与回滚

应用与 0174 增量迁移须配套发布。迁移仅调整角色能力并增加工资访问校验函数，不重算、不复制工资。用户按原部署方式备份后部署。
回滚优先保留新权限校验并修复应用；不得仅退回旧应用而恢复通用 report:view 读取工资的入口。已有表、工资和标记均保留。

远端 PR、最终 Head、Full Gate、一次 Codex Review 及合并结果由对应 PR 时间线记录；本记录不宣称尚未执行的部署或现场验收完成。
