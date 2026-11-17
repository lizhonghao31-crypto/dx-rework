# RP3：完成事实读取与同环境报价导航

依据用户批准《SLA_14_Issues_Repair_Construction_Plan_v1_20261117》v1，范围为 FIX07、FIX08前端/任务读取及FIX10。目标 release/digital-production-v1。已接入RP2实际合并 `7dbd07f023bf023d6581e1cf72e048f03a615766`，其代码树与此前本包依赖的候选 `2e7a8a67fa5c754654b88fa0ee077f12e9a37085` 完全相同。基线对齐不代表新候选已完成独立Review、Full或现场验收。首页进度条暂停，CI B未采用，取消的5处CI筛选未启动。没有部署、生产/Acceptance写入或历史时间维护。

实际完成新增可选 actualCompletion，precision和quality分别保留；completedAt原兼容含义不变，不把日期转午夜。完成可信性不借用责任起点timeQuality。原任务授权先执行；只按同source/task/round读取有效原事实。原完成更正（包括明确未知）优先，不能借回旧寄样日期；登记时间、计划P、责任D不补A。旧缺可选字段只按可证旧值降级。factory/QC原聚合读取不被本次开发任务适配覆盖。

Journey完整与compact读取共享同一完成适配，旧内部completion操作人记录保留；新公共字段不会占用该名称。共享payload没有新增格式或降低版本，只消费原有actualAt/actualDate/actualQuality，因此无新全库回填/重建或迁移。现场启用仍须匹配API与UI；回退代码不改原事件/核实历史。

原Workbench页头表达精确/仅日期/待核/真正未知；可信A缺P不会被说成A待核。原工厂报价与指派入口沿 canManage，复用 quotationHref/createWebUrls 与经过校验的productionWorkspaceDomainHref；根路径及Acceptance不双前缀、母单/PO与原返回上下文保留。没有放宽报价、工艺/材料价格、负责人或业务操作权限。

停工前已按实际task-service/Journey/监督的单元调用方扩展，19文件300项通过；此为历史实际结果，本轮恢复施工没有重新运行测试。

最近一组实际定向证据使用Node22.22.2/npm10.9.9、原workers/正确性预算、标记低权限PG16：lint/API/web类型及19文件300项通过；早期8文件76项作为历史保留；原生寄样日期→未知→核实精确时刻的真实任务/Journey、原认证App页面两项通过，另9项被定向筛除未运行；数据库精确容器清理并核不存在。原认证App实际渲染可信纸样instant、未核实最终确认instant、仅日期寄样、明确未知与核实后instant；组件另核五态及旧可选字段、根/Acceptance报价anchor/返回校验。普通角色全矩阵、真实Acceptance工厂页完整往返及部署后Root复验仍不冒称通过。

原失败保留：新页面测试初用未被原配置发现的.test.tsx，改成受支持.test.ts，未改发现规则；本地首次未构建自身UI包导致import失败，修本地准备；首个PG反例暴露公共completion与旧内部completion操作人字段冲突，改用actualCompletion并明确清空日期，保留更正链与原事实断言。未知请求未重试，未制造完成事实。

额外核对历史route payload为JSON null时：不访问空对象、不制造日期；仍有独立可信 task A 时保留原精确A，无A保持unknown。该新读取兼容分支纳入最终定向验证，不修历史数据。

保持既有时间矛盾分类：Task新完成DTO可以拒绝未来/不可信时刻，但Journey仍保留已知原生未来instant供原chronology求值，不把它降成仅缺时间。原寄样更正链中增加过去1ms观察的保护反例；A、历史和业务状态不改。

## 本地保留状态（2026-11-17恢复指令）

用户最新要求：继续时效本地施工，完成后仅留本地，不推送、不创建或合并PR、不部署、不操作生产，不启动Actions且不主动运行新测试。前三张已合并修复由协调方在用户部署后验收，Work不代办现场。

已在本分支 `fix/sla-rp3-completion-context` 对齐实际merge基线，未提交；tracked/untracked补丁均已在外置恢复目录保留。源代码未在本轮增加新逻辑，继续复核原完成读取、授权先行、精确task/source/round、更正优先级及同环境导航，未扩大到首页进度条或CI治理。原construction-evidence保留基线内容，本包验证资料仍在外置记录，不将未提交结果冒充已提交候选。

最近已执行检查绑定候选基线2e7a8a67及源码指纹 `4303381b05002bf7d5b8c7a4ab6da8e9bc0ba2943484d8554d9bef9a5385559b`：19文件300单元、lint/API/web类型；原生完成/更正链及原认证App两项通过，9项定向未运行，容器实际清理。实际merge与2e7树相同，原始报告保留原testedHead，不改写为本轮新执行。此后未运行测试、构建、Review或Full。

未验证事项：尚无RP3独立审查/准确提交Full、全新提交检出复验、部署后Root五态及原工厂报价完整往返、普通角色全矩阵。FIX08仅在后端与本UI两部分及所需现场证据齐备后关闭。#1013后续Full实际失败（88单Journey读取7101次SQL超过既有7100次预算），原失败保留；不能把已合并或业务定向通过称为完整Gate通过。

后续RP4需PURE原失败路由/堆栈/SQLSTATE或最小触发输入；RP5需确认新增返洗work的正式生效动作与合法锚点，保留旧工作及已开窗口。当前只读准备不代替补丁或验证，不擅自制造P、补历史A、重试未知业务命令。


## 恢复正常PR施工（最新授权）

用户随后允许继续时效修复并推送，正常本地验证/Light/Review/Full恢复；现场验收仍暂停，不部署。当前基线为真实集成merge `31aa7c89c6d0974ef28db012d178ba1e2d585289`。已保存12文件补丁及未跟踪文件后以无重叠快进对齐，所有原文件摘要保持。前述本地保留限制及测试结果均为历史时点，不能覆盖本次最新授权或冒称新基线验证。

新增真实完成读取PG入口接入原LONG_CORRECTNESS_TESTS配置分类，沿已有有限正确性预算和worker，不提高全局超时；避免本地以长链配置验证而最终按普通5秒错误运行。新候选结果待实际运行补记，不把旧300项结果当作当前已验证。

当前基线实际验证：Node22.22.2/npm10.9.9 packages/lint/API及web类型检查通过，19文件347单元、21项canonical协议通过；新鲜标记低权限PG16和原认证App两项定向通过，另9项本地筛除未运行，所属容器停止/移除并确认不存在。实际日志和精确来源见本次construction记录。独立Review、最终Full及现场复验仍未发生。
