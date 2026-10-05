# PR04 产品开发与板房管理台

正文依据 V2.0 §6.2、§6.3、§9.4；确认图2/3仅作为视觉参考。基线 release/digital-production-v1@842f43b8c0b588be6a96508a349db7ebc1019339，main b7d400e623da6381302bf70509ee7fe81b6ac3e8；FULL。PR04独立基于集成基线，目标仍为release，未合并main或修改迁移。

施工期间release合入已批准的PR645，最终基线顺接3684699fb8fa9e8e317f26ec2d65a2603dfeee7a，完整保留238条迁移及双0222身份。该兼容修复内容没有在本PR重新实施；本PR相对最终基线没有迁移差异。

| 正文区域 | 正式入口、事实与行为 |
|---|---|
| 设计师工作区 | /ui/digital-production?workspace=designer → DigitalDesignerWorkspace；共享PageHeader、KpiCard、FilterBar、BusinessTable、Pagination |
| 两个创建入口 | 产品开发（无确定订单）/产品开发（有确定订单）；沿用原sources及sources/:id/confirm命令与原Schema、幂等。确定订单不会记录客户样板确认 |
| 草稿/开发中/待确认订单/已下单 | 只读授权Journey投影，原发布、当前适用路线完成/沿用、原订购信息决定显示视图。先按业务视图统计，再分页；不建立第二套状态机 |
| 客户确定下单 | 仅补原订购字段；同一sourceId、开发资料、版本及原采用轮次保留。部分提交失败保留已创建档案并允许重试 |
| 完整开发单 | 原DigitalDevelopmentPanel；字段、打印、附件、尺寸、复版、继承事实和原业务办理保持原消费者 |
| 板房入口 | /ui/digital-pattern-room → DigitalPatternWorkspace；旧workspace=pattern链接兼容。按原任务环节分栏，款数与任务数分别统计 |
| 真实卡片 | 仅当前真实任务UUID/原task记录；不把材料计划、沿用引用、未创建占位变成任务。主办、轮次、原进入/期限、停留与风险来自原事实 |
| 选中详情 | 原开发单技术资料与材料、原DigitalTasksPanel交接/改派/历史，以及选中任务的原DevelopmentExecutionPanel合法表单。原canExecute/canManage/canControl决定操作 |
| 返回与同步 | 验证过的本地工作区returnTo、查询/分页/选中任务；原写入成功刷新只读投影。原任务、待办、座舱、分析继续共享事实，无新增工资/数量账 |

不修改头版/开发板、工艺/洗水路线、主料核配、辅料到料、客户确认、复版影响节点、计薪、原权限及SLA规则。无拖拽完成、审批放行或新工资来源。成熟订单打板/杂事等页面仅保留统一导航，不改变内部字段和按钮。

验证包含五项投影/权限/返回单元测试、原开发执行/开发单/身份/Journey真实PostgreSQL回归，以及原API桌面创建、补单、原核配拒绝、技术角色负向、返回、分页和旧模块内部对照。最终SHA、FULL、一次Codex Review和视觉证据以交付记录为准。

移动专项按用户决定暂缓。完整角色接力及所有工艺/洗水/复版浏览器场景、线上Acceptance尚未执行；原数据库套件覆盖状态机分支，不等同浏览器UAT全通过。现有TEST款图仅有元数据，无存储对象，不宣称附件上传已验收。已知A4同母单任务元数据及仓库todo入口缺陷保留。未进入PR05–07；外发审批500由其它已授权任务独立处理，本PR没有相关迁移或SQL变更。
