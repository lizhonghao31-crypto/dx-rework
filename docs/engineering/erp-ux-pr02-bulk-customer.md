# ERP 体验 PR02：大货看板客户投影与搜索

目标 `release/digital-production-v1`，基线 `0e198f0989050d7fd7a400b7a6a9453bde71cbfd`；V3-039。与PR01无代码依赖，独立分支施工，Gate FULL；当前 Head Gate 全绿后进行必要 GitHub Codex Review，默认一次。不自行合并或部署。

开发来源允许暂未填写客户，之后关联的履约母单已有客户。座舱已采用母单优先的客户身份，而大货 workroom 的展示和关键词过滤仅取来源客户，于是同一母单可能显示“客户未登记”且搜不到其客户。本次仅将 workroom 的 SELECT 和关键词条件同时改为 `coalesce(o.customer_code,s.customer_code)`，保持原权限范围、JOIN、记录资格、排序、15条分页、计数和派工/生产规则。

当前列表使用母单客户；已发布制单详情 reference 继续使用其原 `order_snapshot.customerCode` 和原回退逻辑。没有客户主档、来源、母单或历史快照回填。API字段和Web组件不变，现有客户搜索提示仍准确。

| 合并前断言 | 实现与验证 |
|---|---|
| 来源客户空、母单客户存在时显示和客户搜索一致 | 真实已有 TEST 命令创建母单、关联无客户来源、开发/制单发布和大货派工；按款号及小写客户查询命中同一母单，卡片客户正确 |
| 座舱、workroom及详情采用同一对象身份 | 对照 `DigitalCockpitQuery`、workroom item、sheet.reference；原制单快照客户保持 |
| 过滤与计数分页同源、没有伪匹配 | 不命中词返回0；同客户跳到超出范围页仍保持总数；原15条页大小不变 |
| 既有权限保持 | 原纸样工人自己的任务可按客户搜索；工人不能请求全部，非工种或离职账号拒绝；原正常四种整单准备链继续通过 |
| 前端消费服务端投影与过滤结果 | 本地 Chromium 挂载实际 `BulkPatternWorkspace`，读取隔离 PostgreSQL 回归输出的合成 TEST 响应，检查款号/客户搜索及空结果；不把静态样板当产品证据 |

定向数据库检查：`npx vitest run tests/integration/sourcing-pr03-postgres.test.ts -t 'ERP V3-039|P11 releases exactly one whole-order'`，5个独立用例通过，其余用例按定向选择未运行。使用独立临时集群、非特权测试角色和安全标记，仅合成 TEST 对象。设置 `ERP_BULK_CUSTOMER_EVIDENCE=<本地JSON路径>` 可从新增用例导出查询响应；浏览器检查用同一变量指向该文件，并设置已安装的 `PLAYWRIGHT_IMPORT`/`CHROMIUM_PATH`，执行 `node tests/acceptance/bulk-workroom-customer-browser.mjs`。不访问生产或Acceptance。

边界：履约母单当前数据库约束要求客户非空；本次不伪造违反该约束的“母单也无客户”真实业务样本。来源未填且未形成合格母单的对象仍按原资格不进入大货列表，前端“客户未登记”兜底没有新增业务规则。历史 D06 实例/部署构建仍未读取，不把上述 TEST 复现写成历史实例根因已证。

没有UI布局改动，浏览器检查只签本次客户显示/搜索消费；不签整页视觉或真机可用性。候选未部署，真实账户从座舱→母单→大货看板的对象/客户与来源返回为 `POST_DEPLOY_PENDING`。撤回仅恢复这两处只读投影差异，不逆转派工/生产事实，不清理历史或客户数据。
