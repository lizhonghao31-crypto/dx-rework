# 模块01第三轮 PR02：首页定稿与时效分类下钻

2026-11-07用户验收PR01并同意进入下一步，父窗口转交明确授权先合并#922再施工PR02；本批完成必要检查后交用户验收，不自动合并、不开始PR03，不部署或改现场数据。PR01使用expected head fb2c7fed0393548dbf605363d4606c14d64f0259正常squash合并，实际release基线3a8c8cd6e40e45755d7028efe9aa6ef84c865f08；父base becb，合并树和已验收候选树均f97f098c7c0af6ece296ea236511930379b13e7e。显式fetch已核目标引用，独立工作树m01/r3-p02从实际合并版本开工，保留#921及PR01。

已重读完整施工方案的PR02及共用约定，并重新实际查看首页定稿原图《生产管理总览订单仪表盘.png》（Library libfile_fde3_f-3a313ed0b0cc8191999ad539ded4ba5f_c8d3bf5d609c8191bce6411a30e94d44）。原图示例数据不作业务值；保留现有Shell、蓝白配色、搜索和业务办理/权限。额外全节点时间专项及沙盘暂停；详情/设置布局不施工。风险FULL：首页读取契约、完整筛选统计和跨页下钻，不是单纯CSS。

## 实施前影响记录

|批准规则|实际入口与既有消费者|初始化、日期和权限边界|验证预期|
|---|---|---|---|
|首页双条及常显预计/实际日期|CockpitHome仅消费PR01 visualProgress，保留旧详情业务要求组件；采用平台CockpitDate、BusinessTable、Pagination|不在前端重算阶段权重、原n/m不改；缺值为—，日期保留原精度；整单颜色沿mainState，不按任一节点风险改整单状态|手算动态0/部分/100及未知、源开发范围、真实日期、F欠收和无可信业务号；旧数量/原事实不变|
|时效待补充KPI和七类明细|原selectCockpitJourneys完整权限候选→原筛选→唯一订单→KPI/分类/分页；新弹窗先分类再通过原journeys读取对应订单|共享每类谓词；fact_time可含已收口事实矛盾，其余沿原未完成范围；重叠分类不相加，原权限、原排序及15条分页保持|跨页与重叠/重复项，七类分别计数=唯一订单数；搜索/客户/阶段/范围及闭单边界一致，加载/失败/撤权不伪装0|
|紧凑订单行和风险弹窗|原在办节点、PO日期和风险事实；复用平台dialog/按钮及原焦点陷阱|弹窗关闭/返回保留原主列表条件与位置，不让风险/悬停撑高订单行；真实阻断和原风险保留于弹窗；编号只用已有可信字段|1165/1366/1584完整页面、长/多PO、单PO、键盘/焦点/关闭、所有风险可读；无开发参考/原长计数/完成办理前/无意义中点|
|本批与详情/设置隔离|只在overview命名空间修改CSS和首页组件，完整App用于本地浏览器验证|不改全局tokens、导航、角色、业务写入；既有返回上下文/权限校验原链保留|原详情和其它消费者定向防回退，最终截图标注本地TEST，不冒充Acceptance现场已验|

本地检查已完成；远端light、正式Review和最终Full在提交后进行，本记录不提前填远端通过。

## 本地冻结验证

来源指纹 `959bfbbba814b953095e3f476ca5425d8bb61bf17fccf7b7231d79214ab37d95`，实际测试父Head/base为 `3a8c8cd6e40e45755d7028efe9aa6ef84c865f08`。Node22.22.2/npm10.9.9，Node/浏览器后代affinity2,3；PG16.15为本任务复用的带标记低权限隔离实例，cpuset0,1、2CPU/2GiB。原canonical business-chain配置两worker，浏览器Playwright1.56.1锁定Chromium141.0.7390.37，测试/hook100秒、独立setup120秒。与CI配置和浏览器一致，宿主硬件及其它负载不等效；本地完整App截图是原认证和TEST业务对象，非现场Acceptance页面。

|检查|命令及结果|凭证|
|---|---|---|
|preflight|`npm run test:preflight`；exit0，249通过/0失败/0跳过|`/workspace/scratch/m01-r3-p02-preflight.log` SHA256 `11ba98657acdfe1c4a55f975330e532fe9b3ff854dc86a8ae443f7747a532bb0`|
|unit|`node node_modules/vitest/vitest.mjs run tests/unit/cockpit-home.test.ts tests/unit/cockpit-display-facts.test.ts tests/unit/digital-journey-cockpit.test.ts tests/unit/digital-journey-projection.test.ts tests/unit/full-gate-risk-map.test.ts tests/unit/m01-cockpit-workspace.test.ts tests/unit/m01-cockpit-reads.test.ts tests/unit/m01-cockpit-reading-context.test.ts tests/unit/digital-cockpit-progress.test.ts tests/unit/digital-cockpit-time.test.ts tests/unit/journey-projection-isolation.test.ts tests/unit/journey-visual-progress.test.ts tests/unit/journey-business-progress.test.ts tests/unit/journey-progress-dates.test.ts tests/unit/digital-pmc-readonly-ui.test.ts --reporter=verbose --reporter=json --outputFile=/workspace/scratch/m01-r3-p02-unit.json`；exit0，220通过/0失败/0跳过|`/workspace/scratch/m01-r3-p02-unit.log` SHA256 `f1fde7155d13ec0d0f3a2abd47ee6db36bcba0e3a03b1494a749095990d5afbd`|
|native|`node node_modules/vitest/vitest.mjs run --config vitest.business-chain.config.ts --maxWorkers=2 tests/integration/m01-cockpit-home-native-browser-postgres.test.ts tests/integration/digital-journey-postgres.test.ts --reporter=verbose --reporter=json --outputFile=/workspace/scratch/m01-r3-p02-native.json`；exit0，40通过/0失败/0跳过|`/workspace/scratch/m01-r3-p02-native.log` SHA256 `001147dc27fe6fd6d0cf1af3dfbb4eecd47c5102dfc6a18f4a042c70e0645475`|
|types|`npm run typecheck`；exit0|`/workspace/scratch/m01-r3-p02-types.log` SHA256 `2df9af99fe74bad919c36bc1d9e2bc160fcb48526566b4a9ff74653fec0dd74e`|
|build|`npm run build --workspaces --if-present`；exit0|`/workspace/scratch/m01-r3-p02-build.log` SHA256 `db81844837e7077c130453fb40b98e893bb36bc3c52bf720511ea6401c20291f`|
|lint|`npm run lint`；exit0|`/workspace/scratch/m01-r3-p02-lint.log` SHA256 `fe68a45f894b97fe42ab32bd073231806b176f891729cd5a5a0715707246e763`|
|secret|`npm run secret:scan`；exit0|`/workspace/scratch/m01-r3-p02-secret.log` SHA256 `e41648ae52b20dec12f1a629ecc0096df7be90f1c557e46cfa97dfbb12429bda`|

本地浏览器7场景及原Journey33场景共40项；原真实认证撤销PMC后同一有效会话仍保留finance_read、订单事实不再返回。31单跨页、七类计数、闭单及重复反例、风险弹窗/键盘焦点、返回原page2/customer/search、原生F欠收2、失败重试均通过。三个桌面宽度和390手机截图已实际逐图查看；普通双PO行高不超过190px，数量居中，打开/关闭风险不改变原行高。TEST样本无款图时保留真实缺图，不捏造图片。

集中复核另发现普通KPI/状态切换会保留旧missing条件，与该KPI完整统计不一致；已清除旧选择并加入原完整App反例。初次预检发现时间候选索引的旧百分比来源移动：只移除已删除的home旧数值候选并增加新的纯数值显示Math.min候选，未触及其它手工注记或重开全节点时间专项。草稿原生夹具颜色重复和严格查询多余view字段已按原契约修复，未放宽业务守卫；旧回退/旧行内摘要断言改为双条与弹窗事实断言，原权限和风险覆盖保留。最终来源全部检查完成后未再改源码。

隔离库最终身份/标记/低权限复核通过，两个库残留schema0、其它连接0，凭证 `/workspace/scratch/m01-r3-p02-db-postcheck.json`。完整diff与消费者定点复核已完成：变更只涉及首页、统计投影及必要原生验证接入，后台SLA、M已接通截止、#921和PR01不变；N现场凭证缺口仍未声称解决。最终Gate前沿原协议绑定实际提交、base、审查与原报告；完成后等待用户验收，不自动合并或开始PR03。
