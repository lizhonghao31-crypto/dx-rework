# 达兴数字生产平台｜资料与核验索引 V1.1

日期：2026-09-29。此索引供新Work定位原件和环境事实；业务规则以同包《达兴数字生产平台_正式施工计划_V1.1_20260929.md》为唯一详细基线。

## 一、同包原始材料

以下文件位于`原始资料/`，为用户已提供的原件，只读复制，未改内容。

| ID | 文件 | 用途 |
|---|---|---|
| Q | 达兴数字生产平台.pdf | 32页问卷V0.3，原答按计划R表被最新用户决定覆盖 |
| F1 | 裤子设计版单(1)(1).pdf | 裤子开发单1页，保留全部字段和版式，开发类型按最新两类 |
| F2 | 上衣设计版单(1).pdf | 上衣开发单1页，保留全部字段和版式，开发类型按最新两类 |
| F3 | 2512071制单(1).pdf | 六页制单原件，公司抬头、船样期限与系统内填写规则按最新决定执行 |
| F4 | 预算表（26年9月10更新）(3).xlsx | 预算字段／原公式／版式；样例不作默认价格，不作日常导入入口 |
| F4-R | 附件4_预算表原件核验记录.md | 已有预算读取记录；不是新业务规则 |

## 二、原始资料校验

原始资料字节数与SHA256保持V1.0交接包一致，详见`原始资料SHA256.json`。V1.1仅更新施工计划、Work接手说明和ENV事实，不修改问卷、开发单、制单、预算Excel及预算核验记录。

## 三、当前代码与ENV事实基线

Repository：`lizhonghao31-crypto/dx-rework`  
计划更新时最新已核验`main`：`04d5c079b3cc767ffc974f24a63dcd0ab1073b6e`  
最新已核验合并：#586（Acceptance共享路径收口）。  
#587 self-hosted Runner方案不再作为执行方向；如仍开放，应关闭、不合并。

Acceptance现场已核验：

- 公网入口：`https://staging-api.dxerp.org.cn/acceptance/`；
- 正式生产API：`127.0.0.1:3201`；
- 旧Acceptance API：`127.0.0.1:3202`，旧运行目录`/opt/dx-rework/acceptance/source`；
- 独立Acceptance数据库：`dx_rework_acceptance`；
- 新canonical根目录：`/opt/dx-rework-acceptance`；
- 低权限运行用户：`dxacceptance`；
- canonical `.env`、`deploy.env` 已创建，权限0600；
- 新Acceptance DB登录和本机HBA规则已完成；
- 切换前数据库备份已完成并通过SHA256及`pg_restore --list`验证；
- GitHub Environment `dx-rework-acceptance`已配置；
- GitHub Hosted Runner连接ECS 22端口超时，因此不扩大公网SSH；
- self-hosted Runner自动部署暂停，后续采用A1—A4四个业务阶段批量人工部署；
- 新canonical runtime和Nginx前端alias首次切换尚未执行，安排在P01—P04完成后的A1验收前。

真实Secret、数据库密码、SSH私钥、session secret、Acceptance Lab secret不写入本索引、施工文件或交接包。

## 四、最新业务补充

- 系统正式角色名称统一为**供应链总监**。
- 开发车板正常SLA：**24小时**。
- 板房尾查SLA：**4小时**。
- 中转、开发寄样、预算、制单、大货QC、仓库发出：暂不设SLA，只记录滞留；其它未确认节点同样先无SLA运行。
- 生产管理座舱新增“工序时效设定”轻量窗口；root／老板／供应链总监可调整节点SLA、无SLA状态和临期阈值。
- 第一版参数调整**立即覆盖所有未完成同节点任务及后续新任务**，按原进入时间重新计算；已完成历史不改；每次调整留审计。
- Acceptance不逐PR部署：A1=P01—P04，A2=P05—P08，A3=P09—P14，A4=P15—P16＋最终候选。

## 五、施工读取顺序

新Work按以下顺序：

1. 仓库`AGENTS.md`；
2. `docs/governance/chatgpt-codex-construction-workflow-v1.0.md`；
3. 本包《正式施工计划V1.1》；
4. 本包《Work接手启动说明V1.1》；
5. 当前main、相关开放PR；
6. 当前P编号所需原始资料。

ENV-BASE已经完成，**直接从P01开始**。不要重新做问卷，不要继续建设Runner，不要逐PR部署Acceptance。

## 六、材料保密与测试用途

预算样例含成本和利润；交接包供负责人和施工Work使用，不作为供应商技术资料包。制作岗位只读取有权限的技术资料。测试订单使用独立测试身份及ID，不能把样例款号直接写入生产数据库当真实订单。


## 2026-09-29 本窗口执行补充

用户已授权开始施工，并授权助手按风险自行增加 Codex Review 轮次；原默认最多一次的限制在本轮按此新授权执行。逐 PR 交付模式不变。T26 已按最新 R38 统一为覆盖未完成任务。原始附件仍以交接包为准，本目录不复制预算和技术单原件。
