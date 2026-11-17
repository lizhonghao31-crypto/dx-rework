# 第四张时效修复：完成事实与同环境报价导航

依据用户批准14项修复方案v1的 FIX07、FIX08完成读取/前端、FIX10；目标 release/digital-production-v1，实际基线31aa7c89c6d0974ef28db012d178ba1e2d585289。

任务新增可选 actualCompletion，保留 instant/date/unknown、可信性及来源。原 completedAt 含义保持，不补午夜，不用责任起点quality、计划P、责任D或审计登记时间填真实完成A。原授权先行，同source/task/routeVersion的有效更正（含明确未知）优先；Journey完整及compact采用相同适配，保留已知未来事实供原chronology检测。

原工作台表达可信精确、仅日期、未核实精确、未知和可信A缺P。原工厂“报价与指派”沿quotationHref与受校验returnTo，保留根/Acceptance基路径、母单/PO及canManage，没有放宽价格或指派权限。新增PG读取用例进入原有限长链配置，不提高worker、全局超时或更改业务断言。

## 实际验证

Node22.22.2/npm10.9.9：依赖包构建、改动lint、API/web类型通过；19文件347项关联单元和21项canonical协议通过。新鲜标记低权限PG16及原认证App两项定向通过，另9项本地筛除未执行；所属容器停止/移除并确认不存在。准确执行时间、命令、输入、日志及结构化结果摘要见本提交construction记录。

首次完整候选ad66aace的唯一Light44065161456成功，Codex Review同Head无发现（摘要6945432642、回执6945499928）。后续修复SHA不冒称重审，不重跑Light；最终Head尚须本次Full及正常核证。

## 基线测试消费者修正

已手动合并的#1016 Full44063103734 non-DB job133971526278实际4285过、2败、11跳过，两败为旧sample-postgres-gate-policy仍要求审核过的单入口test-only变更追加整链。保留原失败，在本PR隔离提交修正这个必要的基线测试消费者，不另改分类规则/工作流或开一轮性能实验。现已核Full+真实PG+准确可运行入口，并新增source、共享fixture、auth、lock、未知domain及多owner保守整链回退反例；两文件147项通过。先前SLA检查在源码整体指纹仍匹配时捕获明确未变输入，排除该未被其引用的独立unit文件；复用原日志，不因无关断言更改重跑PG业务。

## 历史与未验

原实现、失败及补丁已保存在外置恢复目录；本PR不回写日期、完成事件、旧C/D/E或其他业务数据。FIX08只有与RP2后端及所需现场证据一起齐备才关闭。现场时效测试和首页进度条仍暂停，没有部署。

真实Acceptance工厂报价完整往返、部署后Root五态、普通角色矩阵均未验。原#1013 Full性能SQL预算失败保留；合并不冒称完整检查或现场验收通过。返洗后续工作在独立工作区，不夹入本PR。
