# A3 更新：生产 main221 与 Acceptance236 的兼容收口

## 实际阻断与边界

用户执行 `/usr/local/bin/dx-acceptance update e9d687a3c236e04e3749916957578b1b6b85e8c8`，工具 `209b00854c217c9fd2e5a6bbc0f5096c0016df0a` 在 `[1/5]` 只读生产历史校验拒绝 `0221_sourcing_factory_change_crafts`。失败发生在候选构建、备份和停止 Acceptance 之前；不能因为此前 release 组合 tree 通过就认为生产历史已兼容。

main PR625 已合入原 SQL 和精确 checksum 兼容策略，PR626 没有改变它们。release 候选仍为236项；已安装旧工具重复前缀白名单仅到0220。因此必须同时更新候选和显式安装经审核的新维护工具；仅合候选、仅重新执行旧入口，均不能解决。

复用 main 的原 SQL 字节及 `scripts/migration-main-extensions.json`、`migration-history-policy.mjs`。身份 `0221_sourcing_factory_change_crafts`、checksum `0c4b9492ab5d6ac9ba813854dc048aadbfb71784ddd9a62b3a49346d7b2f9438` 不变，原 `0221_digital_production_notifications` 也不变。既有 migration-lib/check-migrations/branches 在 release 已具备相同语义，无需覆盖格式。

整合 manifest 为237项，最高版本仍0233；历史记录、checksum及 applied_at 不改。打包及演练工具复制闭包补入 main-extensions JSON，维护权限清单仅增加新 SQL 所需的既有转厂申请表所有权和决定工艺守卫函数所有权。未知名称、checksum漂移、历史洞、第三个0221仍拒绝。没有放宽生产权限或自动修复所有权。

新 SQL 没有表/列或数据回填；旧请求缺少 crafts 时使用原决定工艺，缺少 baseContractDocumentId 时不新增该基准要求。现有 release 转厂调用仍按旧合同执行；此次不搬入 PR625/626 的业务 TS/前端或累计回传功能。用现有真实外发/合同回归核验这个最小边界。

## 验证

- 精确 main `9fcc05c4` 221项、Acceptance `e9d687a3` 236项为独立冻结 fixture；新增 main221→237、Acceptance236→237、237→237 实体回放。保留旧时间戳和业务哨兵，幂等、漂移及未知历史拒绝。
- 从 Git 取出已安装209b008原始脚本和依赖，执行其实际 `[1/5]` 只读命令片段：生产main221对旧候选报原始 absent 错误；修好候选后旧工具仍拒绝重复0221；新工具策略通过。该测试不是完整 ECS root 更新或现场连接，不涉及 PM2/备份/部署。
- 正式维护生成器由真实 Python3.6.15 运行，并在仅回环暴露的 PostgreSQL13.23 隔离容器执行。沿用维护权限、清单遗漏回滚、部分提交重试、低权限预算办理、序列和官方隔离备份恢复演练；新增PG13选项，不放松断言。
- 所有当前 catalog 数量断言改为manifest长度；冻结225、236历史仍按原身份固定，未伪造新增迁移已执行。
- 最终 Head Full Gate 和必要的一次 GitHub Codex Review 完成后才交付执行方案；本 PR 不安装线上工具、不合并、不部署、不重启。

## 单一路径：显式工具升级后再更新候选

合并后锁定实际 release 40位SHA，确认它含本次全部修复及最终Gate/Review证据。用现有生产源码仓库的已配置认证仅fetch，不checkout生产工作区。另在 `/tmp` 建立干净checkout，以该同一SHA调用既有 `scripts/dx-acceptance.sh install`，再执行 `/usr/local/bin/dx-acceptance update <同一SHA>`。

安装必须由root显式执行，且来源checkout必须干净；不可对旧不可变工具目录覆盖文件，不可手改旧白名单。安装步骤会保留旧工具版本并原子切换入口。新工具版本与业务候选版本分别记录。本次需要更新工具是已确认阻断的必要修复，不是一般业务更新自动升级工具的规则。

执行前为用户生成包含准确SHA的独立bash脚本，使用原安装实现；不把set-e/exit等维护动作source进登录Shell。fetch后先核验候选属于release；安装验证新入口指向准确工具SHA并确认main-extensions存在；任何准备/安装失败不调用update。更新本身继续既有生产3201健康/配置、只读历史、权限、备份、Acceptance3202停止/迁移/同代切换及验收流程。无跳过检查，无生产3201部署，无在线补数据。现场配置/权限仍以入口实际检查为准，不能以本地演练代替。
