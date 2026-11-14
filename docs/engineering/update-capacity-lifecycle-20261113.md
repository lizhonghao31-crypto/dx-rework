# 更新容量与临时产物生命周期

用户授权修复 Acceptance 及今后的生产更新机制，提交独立 FULL PR；不部署、不操作服务器或业务数据，时间专项 PR04 暂停。实际 release 基线为 `64a2ccf828f4c262ef60d1dbb57463607acb4ab3`，分支 `fix/update-capacity-lifecycle`。

目标：按实际执行分支、每个文件系统的新增峰值核算容量；已存在的文件不能重复收费，真实同时存在的副本不能漏算；临时产物及时退出生命周期，保留日志、运行/回滚版本与备份。预估不是空间预约，重操作及停服前继续复检。

|授权规则与来源|写入入口与消费者|历史/失败边界|必要验证|
|---|---|---|---|
|用户要求以后更新无需反复人为清空间|Acceptance launcher、worker、capacity；生产 deploy-ecs、immutable release 路径|同 SHA 重试、已有候选、工具相同；锁、真实短缺、跨文件系统|真实临时文件及模型测试、实际脚本派发和失败收尾演练|
|不能简单删去三份依赖预算|package-release 的解引用复制、install-release 的 API/frontend 分阶段复制|未知依赖保守估计；匹配 lock 只提供尺寸证据，不代替验证|新构建及复用分支的分阶段峰值与准确缺口|
|不碰运行、回滚、备份、数据库|临时源码/build staging 的拥有者、路径与引用核验|不自动删旧发布或备份；失败保留诊断依据|路径/链接/并发与失败注入；相应部署工具演练|
|生产和 Acceptance 各按实际生命周期|生产持久源码构建与 Acceptance immutable 三副本分别建模|生产不能沿用 Acceptance DB 身份或复制预算；不能削弱现有保护|生产已有入口回归、部署/迁移/恢复必要演练|

当前调查：三份依赖真实存在；候选存在时 worker 跳过构建但 preflight 仍收费；目标与 TOOL_SHA 相同时 launcher 不刷新工具但预算仍收费；API 预算包括前端输出后又另收前端；缓存和解包全依赖量与之后数据库最坏预算叠加；成功 build 与失败源码快照缺少结束生命周期。生产 persistent source 与 immutable bundle 两条路径须分开处理。以上为源码核实，未操作现场；实际磁盘节省须以新回归及现场执行回执为准。

实现及实际验证结果在提交前补齐，不把调查当测试通过。

## 实际修复与边界

- 原 build 公式约 `3×(S+D+O)+O+cache(D)+tmp(D)+backup+rewrite+WAL+logs+headroom`。前三份依赖实际复制，不当作重复删除。新公式按 build/install/database 并存阶段取逐卷最大值；API 输出 A 与前端 W 分开，安装 API 不再包含 W。tmp 在构建后实际清除；cache、build、candidate 等仍存在的文件仍算在后续峰值里。
- 完整 checksum + 来源验证后的既有候选不重新收 build/cache/tmp 费，安装只收缺少的实际副本；已有副本不同则拒绝。相同运行 SHA、相同 API/Web 指向、全部迁移 checksum 相同的验证/激活重试不执行新备份或迁移，预算按该实际分支处理。
- 无 schema 差异时取消整库 rewrite 预算，保留 256MiB WAL 运行增长及逐卷 operating headroom；新更新仍做原来的一次新备份。确有或不能排除迁移时，重写/WAL旧保守预算保留，不根据SQL关键字猜“轻迁移”。备份前、停服前重新读取真实容量和固定身份。
- 工具与目标同 SHA 不预算不存在的 refresh。首次构建和未知 lock 仍保守预算；不能承诺任意依赖升级只需固定小空间。
- 回收已校验且无引用的 build 工作目录，失败源码按精确文件清单清除、证据保留；安装和提取临时目录仅清本次拥有的 staging。生产持久源码、候选/安装代、前端历史、备份和 npm cache 均不借此自动删除。
- 生产 persistent source 新增对应真实分支的容量检查，共享 immutable installer 新增按待复制实物尺寸及目标挂载检查；两条旧 remote transfer 入口在解压前按 tar 实际展开尺寸复检。生产原锁、身份、迁移和恢复要求未减少。旧 remote incoming 的历史目录不自动扫删，也不把它们当未来可用空间；当前推荐入口没有该本机 tar 中转。
- 仓库中未找到名为 `install-remote` 的独立安装器，不能声称已修改服务器侧未知包装脚本。仓库固定安装入口及本次失败 snapshot 路径已覆盖；更新工具仍须用户通过审核的正常 install 步骤安装。

本地最终针对性结果：49 项 Vitest 全通过（其中原 Python 入口执行27项模型、真实临时文件、跨卷及安全边界），preflight 和目标 ESLint 退出0。实际安装复制失败、激活恢复/维护模式、并发锁、build/backup/stop 容量不足前置保护已覆盖。新增可选 ledger SQL 接入既有真实 PG13/15/16 maintenance drill，保留 backup/restore 等 canonical FULL 演练；目前尚未跑远端 Full、Review，未部署、未操作现场、未声称现场实际节省字节数。原始日志 `/tmp/update-capacity-evidence/`；提交内 `construction-evidence.json` 绑定被测输入。

## #978 吸收最新 release（2026-11-13）

独立工作区从原 Head `580d421e45851e96286ee378f2d5342e066d36e9` 合并最新 release `07dff9b8ab2b66f75c6696dc837480c33f48412b`。唯一冲突是当前 construction-evidence.json；容量/部署代码与报价业务代码无交叉冲突。已按最新真实 base 和合并后的源码指纹重建本 PR 当前证据，旧报告仍可从原 Head 读取，不冒充新组合验证。

对新组合重新执行原容量、存储、更新派发、生产入口与失败恢复定向测试，8文件49项全部通过；重新执行 preflight 与目标 lint 均退出0。日志及 JSON 报告位于 `/tmp/update-capacity-reconcile/`。逐文件比较确认容量脚本保持原 #978 内容，apps/packages 保持最新 release 内容。此次只更新分支及冲突证据，不取消草稿，不部署、不操作服务器；PR04 的在途 CI 未受影响。
