# 时间专项 PR01：统一计算与版本契约

批准依据：[完整时间专项第27版](https://chatgpt.com/space/page_891fdec8ad94819180092e756e8d8e22)及2026-11-13用户“好，开工”的8 PR计划授权。
目标release/digital-production-v1，实际base `908344818941c2910eef024cf2e07aa58bbe34f8`，工作分支feat/time-framework-01，核心时间算法按FULL。只做候选计算和版本读取基础；不迁移业务事实、不启用采用、不改权限、页面、业务表或运行配置，不部署。

## 实际影响与完成标准

|批准规则|写入/计算入口|读取与旧消费者|初始化/历史|验证|
|---|---|---|---|---|
|里程碑倒排、小节点正排、责任分别存在|order-time-framework.ts候选计算，无业务写入|新版本显式decoder；旧order-time-schedule及全部fixedTimelineForward消费者继续三参数旧行为|从seriesMilestones原A/B偏移建立明确版本，旧v1不推断里程碑|新手算及原order-time-plan/fixed-timeline/series用例|
|未ready可排计划；每个里程碑检查；并行不相加|原buildOrderTimeWork/日历/DAG复用，新增里程碑完成集合比较|已知晚的必要分支不被其它unknown抹掉|未知必要用时不填0，缺项不能生效|中间不足而最终足够、并行非关键支路、内含、星期日、阶段预留|
|晚批准仅对新候选剩余工作施加生效下界|fixedTimelineForward新增可选下界/保留安排|日常旧读取未传新参数，不滑动基准|保留已完成/已开始工作依据由后续原生适配提供，不能猜实际起点|迟批准、已有完成、下界不逐节点重复累计、原消费者回归|
|新格式回退可读、预览不污染正式|冻结序列化只接order_proposal；不写DB|readTimeFrameworkPlan识别v1/v新格式，未知版本拒绝|PR01提供兼容reader基础；PR06以真实新格式数据库样本和明确回退SHA验，PR08核最终增量|JSON往返、缺层/未知版本拒绝、预览隔离、多个scope隔离|
|责任仅取原生已进入窗口|纯责任评价，无开钟命令|复用scheduleElapsed与shiftFixedTimeline原日历|新公司值不进入已开窗口；未知来源不判无责|逐PO未进入、日期精度/未知、完成冻结、真实终止冻结|

完成后改期的历史+1天保护：PR02读完成时版本，PR06写新当前版本且不覆盖历史，PR08原App贯通；本PR只提供不同版本可分别保留和读取的基础，不宣称历史接线完成。

Full 43406543422 暴露原有读模型队列残留：准确base与候选均复现fixed-timeline-postgres的失败恢复断言。JourneyFactRepository的目标及返工派生写入绕过同事务读取代理，导致第二次待更新集合读取命中写前缓存。改为同一代理client执行原SQL，让既有写入失效机制生效；不改数据库事务、业务时间、权限或队列确认范围。用原失败恢复、首次成功构建、返工、增量队列及快照复用反例核验，原失败结果保留，不放宽断言。

每个PR合并后由用户更新Acceptance并实测通过才开始下一项。此PR的Acceptance重点为现有读写未切换、旧单日期/责任/入口保持；新框架真实采用与现场业务贯通属于后续授权顺序。
