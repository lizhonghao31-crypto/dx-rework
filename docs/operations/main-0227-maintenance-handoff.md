# 0227 主站维护发布交接

本修复只补齐 #783 遗漏的发布准入和交付脚本，不改变业务 SQL、历史 migration、Acceptance、业务权限或计算规则。用户决定合并并亲自执行更新；本 PR 不部署或操作生产。

## 施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 688ff4726c8dc2e1c1767625d5197bdc87e40972
working branch: fix/main-0227-maintenance-admission
task scope: 0227 精确维护准入、main 专用工具刷新、可重复执行交付及对应回归
allowed files: main-maintenance-plans.json、main-0227交付脚本/文档、对应单测与PG13夹具
forbidden files: 历史migration、业务实现、Acceptance、生产数据、部署环境和密钥
gate class: FULL
```

## 准入范围

`0227_qc_other_craft` 精确 checksum 为 `2b4ee5e688926de2d9195e762140fe80ef6dba2ccdaa0cae6575c321426b0748`。

- 所有权和 TRIGGER：`public.rework_orders`、`public.rework_process_configuration_items`。
- 已有函数所有权：`public.guard_rework_order_write()`，迁移中的 DO 会重新定义该函数。
- `public` 必须为当前 schema，并有 USAGE/CREATE；需要 plpgsql USAGE，用于两项新函数和保护函数替换。
- 不允许在线迁移。未登记、指纹漂移、对象或语言权限不足必须在候选构建/维护切流之前拒绝。脚本只检查权限，不自动授权或变更对象所有者。

## 用户执行路径

完整原文为 `docs/operations/main-0227-update.sh`，必须作为独立 Bash 脚本运行，不能 source。交付时把原文嵌入创建临时文件的 heredoc，附 SHA256 核对及执行行；不让 ECS 依赖尚不存在的 /tmp 文件、附件下载或用户手工拼脚本。

支持两种明确绑定：

1. `--approved-sha <已核验的最终合并main SHA>`：正常更新要求远端 main 精确匹配；维护续跑绑定已经冻结的同一候选，允许远端 main 此后继续前进，但该候选仍须为 main 的祖先。
2. `--approved-tree <最终审定Head的Git tree SHA>`：用户合并后，脚本获取 main 并核对完整源码树相同，再以实际 main commit SHA 发布。这样不需要猜未来 squash/merge SHA；尚未合并或 main 混入额外改动时拒绝执行。维护续跑仍核对原冻结候选的审定源码树，不替换候选。

最终源码树值在最后一次修复和 Gate 后读取 `git rev-parse HEAD^{tree}`，只写入交付命令的参数，不能写进该源码树造成自引用，也不能在未重新核验时沿用旧值。

脚本依次完成：

1. 从已有 main release state 读取 Node 和 nginx 路径，独立 SSH fetch，冻结并重新验证已批准源码。没有旧 active SHA 或固定业务端口常量。
2. 以 dxrework 身份做完整迁移历史、0227 指纹和权限只读检查。只接受待应用0227或完整历史已经当前；拒绝其他迁移组合。
3. 仅运行 `install-online-entry.sh` 刷新 main 专用工具，核对已安装准入表相同，且两个绝对入口确实指向本次目标工具目录。不调用同时安装 Acceptance 的 `install-update-entries.sh`。
4. `0226→0227` 或维护中断续跑使用 `/usr/local/bin/dx-rework-maintenance-update`；schema 已经0227而代码目标不同使用 `/usr/local/bin/dx-rework-deploy`；已经处于目标版本时不再调用发布入口。
5. 原生控制器负责锁、维护503、在途请求排空、静止备份、受限事务迁移及同一候选续跑。DDL 已提交后不能启动旧 schema API，不覆盖业务数据库进行回滚。
6. 从实际 active receipt 读取端口，核验 completed、current、Git SHA、schema/expectedSchema、ready/protocol2、前端文件/HTTP和公网版本。

成功标志为 `MAIN_0227_UPDATE_FINISHED sha=<实际目标> schema=0227_qc_other_craft ...`。重复且已更新会先输出 `ALREADY_CURRENT`。失败保留日志、候选、备份和收据，不能把失败信息当成成功，也不能换目标强行继续维护。

## 证据边界

- 单元回归实际执行离线 Bash 交付脚本，模拟 Git、工具安装和运行探针，覆盖新工具与 launcher 一致性、两种入口、两种端口、已更新、拒绝未批准源码/不同冻结候选及无额外迁移。
- `tests/fixtures/main-0227-maintenance-pg13.mjs` 仅用于带标记的本地独立 PG13 测试库。SQL及受限角色权限真实执行，nginx/PM2/备份等运行探针为夹具；不得称为真实 ECS 维护演练。保留前226条迁移收据及时间，验证真实DDL失败回滚、提交后启动失败、同候选续跑和重复迁移零应用。
- PG13夹具 ACL 调整仅是隔离测试设置，不属于发布操作；其 admin URL 必须显式提供并与受限测试库的本机host/port/database一致。
- 最终 Head 执行仓库 Full Gate，必要 Codex Review 最多一次。未在生产验证，也未执行真实 OSS、钉钉或业务数据操作。
