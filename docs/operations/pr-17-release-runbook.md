# PR-17 A 阶段发布与恢复手册

## 边界与准备
仅操作 `/opt/dx-rework`、`dx-rework-api` 和独立返工 vhost。禁止触碰 ERP/样衣目录、进程、数据库和 vhost。基础设施负责人提供域名、TLS、低权限 SSH、host key、数据库、bucket、corpId、actorId 和维护窗口；脚本不猜值。先用精确 40 位 SHA 构建 release，再运行只读 preflight。默认 `DX_REWORK_APPLY=false`。

## 发布顺序
1. 记录 base/head、批准人和窗口；运行全部仓库门禁。
2. `build-release.sh SHA TIME OUTPUT` 生成稳定 manifest/checksum。
3. 目标机只读 preflight；确认结果无 fail/blocked。
4. 经 GitHub protected environment 批准后显式设置 apply、environment approval 和 SHA 确认。
5. `release.sh` 严格执行备份、migration history、可选 migration、安装、原子激活和只读 smoke。
6. 观察 ready、错误率、延迟、磁盘、数据库连接、Nginx/API 日志至少一个维护窗口，并归档证据。

## 故障、停止与回滚
P0：数据安全/跨系统影响，立即停止并隔离；P1：登录、审批或金额关键路径不可用，停止放量并回滚；P2：局部非关键故障，保持现场并评估。任何 checksum、schema、ready、PM2 cwd、vhost 或日志泄露异常都停止。仅回滚到登记且 checksum 完整、schema 兼容的明确旧 SHA；失败不循环尝试、不删除 release/日志。

## 恢复演练
恢复只能使用 `DX_REWORK_RESTORE_DRILL=true`、二次确认、带 drill 标识且空的隔离库。校验 checksum/metadata/custom format 后恢复，记录脱敏 fingerprint、RPO/RTO、migration/schema/一致性查询。不得 drop/overwrite 生产库。真实数据库、OSS、钉钉、Todo 均留待 B 阶段显式授权。

## 证据与回滚本次代码
证据按 Head SHA/Run ID 归档，去除 query、Authorization、token、session、URL 凭据。若撤销 A 阶段代码，revert 本 PR-17 提交；不会改变业务数据、业务规则、权限、UI Golden Source 或 migration。
