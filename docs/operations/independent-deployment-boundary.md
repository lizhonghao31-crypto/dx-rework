# 独立部署与运维边界（PR-01）

本文件定义未来 staging/production 的边界，不授权本 PR 修改 ECS。

| 能力 | 返工系统独立值 | 禁止事项 |
|---|---|---|
| 根目录 | `/opt/dx-rework` | 不进入 `/opt/daxing-erp` 或 `/opt/daxing-sample` |
| Release | `/opt/dx-rework/releases/<git-sha>` | 不用阶段名代替 SHA，不原地覆盖 |
| Current | `/opt/dx-rework/current` 原子软链接 | 不复用 ERP current |
| 前端 | `/opt/dx-rework/frontend/releases/<git-sha>` | 不写死旧 release 路径 |
| API | `127.0.0.1:3201`、PM2 `dx-rework-api` | 不 restart 现有 ERP/样衣进程 |
| Nginx | 独立 vhost/域名；配置版本化 | 不追加到现有混合 staging vhost |
| 环境变量 | `/opt/dx-rework/shared/.env`，权限 `0600` | 不复制 ERP `.env`，不把值写入 GitHub |
| 日志 | `/opt/dx-rework/logs` 与独立 logrotate | 不与 ERP 共用文件 |
| 备份 | `/opt/dx-rework/backups/postgres` 与数据库级备份 | 不把“备份成功”当成“已可恢复” |

## 首次部署前硬门槛

1. 基础设施负责人评估共用 ECS 的安全更新与容量，安排维护窗口；
2. 独立域名、TLS、端口与安全组经核验，不覆盖 ERP vhost；
3. release 目录名、`/version.gitSha` 和 GitHub Head 三者一致；
4. `nginx -t`、PM2 cwd、live/ready/version 与前端静态资源 smoke 全部通过；
5. 数据库备份完成，且执行一次真实隔离恢复演练并记录 RPO/RTO；
6. 回滚到上一个 SHA release 经验证；
7. 日志脱敏与 logrotate 实际生效。

这些验收属于 PR-17；PR-01 仅提供可审查模板和边界。
