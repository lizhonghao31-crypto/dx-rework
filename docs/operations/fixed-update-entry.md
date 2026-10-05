# 固定更新入口

本次范围为发布工具，不修改业务审批、历史 migration 或 UI。PR1 基于 release/digital-production-v1 3684699f；PR2 基于 main ab028c31，保持独立分支历史。两项均使用 FULL，不合并、不部署。

首次由用户从最终合并且审核过的准确 release SHA 的完整远端 checkout 执行 `bash scripts/dx-acceptance.sh install`。不要从生产 partial/promisor 仓库 local clone、shared clone 或复制对象库。安装产生 root 所有的不可变工具版本及原子入口；中断后可以从同一干净 checkout 重试，已有版本不完整时拒绝覆盖。

之后固定使用：

```sh
dx-rework-update main
dx-rework-update acceptance
```

main 复用既有 dx-rework-deploy 入口，不依赖先人工更新 Acceptance。安全切换能力另由 PR2 提供，不能仅安装 PR1 就宣称 main 发布安全。

Acceptance 通过现有 dxrework Git SSH 身份从唯一远端建立独立完整对象库；不改变生产 checkout，不读取或输出私钥。准确候选必须属于 release 分支历史，完整性检查与 archive 完成后才继续。旧工具自身验证新快照：scripts/infra 的全部执行代码、迁移校验策略、依赖锁定必须完全一致；只允许冻结迁移历史不变、新增迁移 SQL 与清单精确匹配，以及 main 扩展清单追加。审核过的执行策略据此自动安装候选绑定的工具数据版本并原子更新入口，保留旧版本。工具版本与候选版本分别输出。

如果工具代码、策略或依赖改变，返回 `TOOL_CODE_UPGRADE_REQUIRED`，发生在构建、备份、停止 Acceptance 和 migration 之前。这里不是未经审核任意 HEAD 的 root 代码自更新通道。未知历史、checksum 漂移、SQL/清单不一致继续拒绝；后续编号超出现有已审核策略时也不能自动放宽。真正的新执行策略需独立审核和明确安装，正常业务与兼容清单更新不再靠用户拼脚本。

PR1 保留既有 Acceptance 的停止/迁移/恢复流程，不承诺它无中断；无阻塞发布与数据库不兼容边界由 PR2 明确处理。不能用工具刷新成功代替业务发布、Gate、Review 或线上验收成功。

隔离证据：Node22.22.2 定向四组 27 项通过；真实 PostgreSQL13.23 十种历史升级通过，包含冻结 main222→release238、旧main/Acceptance历史、部分事务提交重试、checksum/未知历史拒绝与业务哨兵/原 applied_at 保留。本地 npm run check 全部通过。真实 Python3.6 容器执行原 installer 两次，不可变版本及两个原子入口安装/重试通过；同解释器执行真实238项策略校验通过。上述不是生产 ECS 安装或真实业务持续下单演练。
