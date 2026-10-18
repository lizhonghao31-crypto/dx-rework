# ERP 体验 PR03：保存路线与运行后继一致

目标分支 `release/digital-production-v1`，基线 `0e198f0989050d7fd7a400b7a6a9453bde71cbfd`；V3-038。独立于PR01/02，Gate FULL，最终Head绿后必要GitHub Codex Review一次。不自行合并、部署或操作真实订单。

隔离TEST复现了一个确定的代码不变量失败：首轮工艺完成后原自动衔接不创建转交车板任务；当后续整件样板轮次只重做工艺、继承已完成车板时，原路线计划会将尚无完成事实的转交节点保留在 `route_nodes`，并继承车板和洗水。运行时却把该转交节点临时替换为保存路线没有的车板节点；车板完成后无法在本轮路线中找到位置，适用尾查不能继续生成。

运行推进 `DevelopmentRouteService.advance` 和后继预测 `developmentNextSteps` 共同限定原自动衔接条件：后继转交之后在保存路线中确为车板时，继续原自动衔接和实际接收校验；其余按已保存后继创建任务。本轮已继承车板的情形因此执行原路线包含的转交、尾查、确认和寄出。不修改路线选择、继承事实、`output_kind`、工序前置、计时、角色、数量或工资规则；旧QC返工与本厂做尾状态机不在本PR范围。

| 断言 | 实际隔离验证 |
|---|---|
| 红灯复现 | 新集成回归在旧产品代码下失败：本轮存在不属于保存路线的运行任务；4项路线计划单元通过，保留原业务计划依据 |
| 保存契约不变 | 单元确认工艺整件轮次保存“工艺→确认→转交→尾查→确认→寄出”，已完成车板/洗水仍为继承，不要求重做车板 |
| 运行身份、前置和唯一性 | 实际原TEST命令创建/完成首轮，再发布上述第二轮；并发同幂等键工艺确认只形成一个本轮转交，所有运行节点属于保存路线；转交前不创建尾查，转交后适用尾查ready、4小时 |
| 合法与拒绝 | Root按原特殊能力办理；原QC身份不能执行开发工艺确认；原车板材料/派工/实物接收拒绝保持；历史原件不改 |
| 原路径回归 | P07原四种工艺/洗水组合、工艺布片不生成尾查、车缝返修多轮/尾查退回、原系统衔接和工资资格保持；本次定向测试10项通过，其余49项因选择未跑 |

命令：先 `npm run build:packages`，使用已核安全标记的显式隔离 `TEST_DATABASE_URL` 运行 `npx vitest run tests/unit/digital-development-rounds.test.ts tests/unit/digital-development-route.test.ts tests/integration/full-business-chain-postgres.test.ts -t 'revision work versus inherited facts|P07 development routes preserve|moves no-craft|describes|hands revision|keeps the clerk'`。记录中红灯与绿灯是同一组新增业务断言的前后结果，不以测试文件数代替场景覆盖。

首次GitHub Codex Review确认一项P2：nextSteps预测仍会无条件跳到已继承的车板。已用新增单元在原Head复现错误，并将 `developmentNextSteps` 采用同一保存后继判断，集成同时核实际返回的预测。修复后3文件11项通过（其余49项定向未选）；运行与预测共同遵守原路线，不改变业务选择。第一次Review已用；父窗口已独立核运行/预测两处修复及新增回归。按一次Review、逐条修复/回归、父核diff和新Head Gate交付，不因P2擅自第二次Review，不虚造“新Head缺再次Review”阻断。记录原审查Head与修复Head，不声称旧审查实际审了新增差异；仅真实GitHub强制检查另有未满足项时附具体证据报阻断。

本PR无前端改动。本地证据为实际服务、事务和PostgreSQL中的合成TEST路线、任务、权限及工资事实；对应候选上的真实页面、账号和跨角色接力为POST_DEPLOY_PENDING。真实M01历史实例的路线/记录未读取、未修改，历史根因仍未证；上述代码复现不冒充M01归因，不重试旧ECS脚本。

无schema/migration。撤回范围为本条件差异；已发生的任务/审计不能靠回滚代码抹掉，真实环境若需处理须另行授权，优先评估兼容前滚，不删除或重写历史。
