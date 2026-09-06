# 样衣迁移 PR-5 施工与切换记录

基线 main：`10deeddf5034366e90257c249603aeb9a3e3e51e`（PR-4 #408 已合并）。
允许范围：样衣 contracts/API/必要操作入口、增量 migration 0157、样衣测试、迁移脚本和本运行记录。禁止修改返工、外发、供应商与生产看板业务规则；不覆盖既有 migration。
业务依据：`docs/requirements/sample-system-migration-v1.0.md`。负责人已授权连续施工、Gate、每 PR 至多一次 Review 和合并；明确将 UI 验收后置。浏览器五宽度截图尚未验收，构建通过不代替浏览器验收。

## 当前事实

- PR-1 #405、PR-2 #406、PR-3 #407、PR-4 #408 已合并；PR-4 Review 的同事项钉钉待办关闭问题已修，Full Gate 34016999861 通过。
- 生产只读快照：540 件样衣、784 条日志，当前均为借出中；540 条借用历史，无在途申请及处置历史。唯一对象 563 个。
- 快照 SHA-256：`dbfe811a8a8a8bcaefaaeff0532d29334a866f0de5ad8732c71f2088143e1379`。
- 4 件缺少采购小票、55 条孤儿日志，必须保留并补充具体处理结论；人员必须映射稳定平台 ID。旧“财务/系统确认”等角色标签不冒认为某个人。
- 上述盘点不等于正式生产导入、源冻结、角色配置或切换完成。新系统默认写入关闭。

## 可重复预演

Node 22 / npm 10，先 `npm ci`、`npm run build:packages`。所有源数据、映射和结果目录在仓库外，目录 0700、文件 0600；不提交真实员工、金额、小票、签名链接或会话。

1. `node --import tsx scripts/sample-inventory.ts --read-legacy-api /secure/sample-source-TIMESTAMP`
2. `python3 scripts/sample-verify-objects.py /secure/sample-source-TIMESTAMP/inventory.json /secure/sample-objects-TIMESTAMP`
3. 通过环境变量设置 `SAMPLE_PLATFORM_API_URL`（平台 API 基础地址）和当前管理员的 `SAMPLE_PLATFORM_SESSION`。不在命令行、日志或 Git 中填写会话。
4. `node --import tsx scripts/sample-transfer-objects.ts /secure/sample-objects-TIMESTAMP/objects.json /secure/sample-transfer-TIMESTAMP`
   使用平台上传、OSS 与 finalize 生命周期；相同输出目录可断点继续。部分失败时保留已转存对象映射；源对象不删除。
5. `node --import tsx scripts/sample-plan-template.ts /secure/sample-source-TIMESTAMP/source.json /secure/sample-plan-TIMESTAMP`
   模板中的 null 和空结论表示未解决，不能执行导入。依据 contracts `sample-import.ts` 填齐稳定员工 ID、历史/在途请求、转存对象映射及逐项异常结论。初始领用历史的未知申请人可保留 null，但必须有专门异常结论、原记录哈希和迁移批次；不可用管理员替代未知历史操作者。已有处置和在途请求必须逐条填写，不能用空数组跳过。
6. `node --import tsx scripts/sample-migration-execute.ts validate SOURCE.json PLAN.json /secure/validate-1`
7. `node --import tsx scripts/sample-migration-execute.ts import SOURCE.json PLAN.json /secure/import-1`
8. 使用完全相同 SOURCE/PLAN 再运行到 `/secure/import-2`。两次对账均通过且无新增重复主档、借用历史、请求或待办才算重复预演通过。

导入采用批次/源哈希/旧 ID 幂等。最终增量只在样衣写入关闭时执行，目标版本必须仍是上一迁移版本。历史只允许补充原始新记录或首次结束持有，不能覆盖已有历史。所有主档、状态、人员、历史、处置类型、五项金额、附件状态及待办重新核对；失败整批回滚。原始日志与未知历史角色保存在不可变来源表，只有管理员可通过 `/samples/migration/batches/:id/evidence?kind=log&page=1` 每页 15 条读取。

## 冻结与正式切换

1. 在维护窗口备份旧 `/opt/daxing-sample/data/native-store.json`、平台 PostgreSQL 和附件对象/元数据清单；完成独立恢复演练，留存证据。
2. 将 `scripts/sample-legacy-readonly.conf` 纳入旧样衣域名现有 Nginx `server` 块。核对线上旧服务路由仍与已审计版本一致，执行 `nginx -t` 后 reload。它阻断旧保存、迁移、变更、上传及全部二维码路径，保留 GET 读取和只读的附件签名接口。
3. 核对反向代理错误日志、配置和旧服务仅监听回环地址；确认不存在绕过冻结的其他入口。禁止用真实业务写入请求探测冻结是否成功。
4. 冻结后重新盘点源 JSON、附件和人员增量，执行最终导入两次及对账。按状态、当前持有人、借还历史、处置、采购总额/在管原值/处置原值/出售回款/遗失赔偿、附件和待办逐项验收。
5. 财务、行政、老板/管理员完成代表性 UAT。准备 `SampleCutoverSchema` 的 enable 文件：最新 reconciliationId、最终 sourceHash、源冻结、备份恢复、业务 UAT 证据和原因。
6. `node --import tsx scripts/sample-migration-execute.ts cutover SOURCE.json ENABLE.json /secure/cutover-result`
   脚本重新只读获取旧源哈希；服务端要求最新通过的两次对账，并重新检查数据和附件。核心不一致时不开放新系统写入。
7. 旧系统持续只读；按已确认的平台员工分配样衣角色，核对真实待办人数与权限。UI 验收按负责人后置指示单独补齐，不宣称截图已通过。

## 回滚

- 先用相同 cutover 命令提交 `{"action":"disable","reason":"具体故障及回退记录"}`，关闭新业务写入，保留新数据和审计。
- 如果切换后已有新业务写入，先导出并核对新旧差异；不得直接将旧快照覆盖新平台，也不得同时恢复两端写入。
- 在确认恢复点及新业务保留方案后，移除旧只读 include，`nginx -t` 后 reload 恢复旧系统写入。保留所有源快照、附件映射、对账与切换日志。
- 数据库采用向前修复；不 DROP 样衣表，不删除主档/历史，不反向覆盖 migration。必要恢复在独立实例验证后按平台既有部署流程执行。

## 固定 UAT 与证据入口

- `sample-create-postgres.test.ts`：原子建档、不同持有人、同批小票、跨批拒绝、并发编号、财务隔离。
- `sample-workflow-postgres.test.ts`：借出/归还待确认、在库/借出中、稳定身份、过期/重放二维码、双行政待办及钉钉关闭、批量幂等与并发。
- `sample-disposal-postgres.test.ts`：出售、赠送、在库/借出中报废、遗失审批及待赔付/结案、拒绝回原状态、各角色拒绝、Root 更正/归档/恢复、并发审批。
- `sample-import-postgres.test.ts`：同名稳定 ID、离职拒绝、附件哈希不符、重复导入、最终归还增量、五项金额、源冻结后的切换及新业务版本保护。
- 生产异常不能用固定测试替代；最终员工映射、缺失小票/孤儿日志结论、对象实测报告、源冻结与生产恢复/UAT 证据必须使用真实结果。

本地 PGlite 用于诊断 SQL 与状态，不代替 Full Gate 中真实 PostgreSQL 的事务并发和备份恢复。每个 PR 仅在当前 Head Full Gate 全绿后请求一次 Codex Review。
