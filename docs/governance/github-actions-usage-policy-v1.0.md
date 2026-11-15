# GitHub Actions 执行政策 V3

长期规则见[AGENTS §4–5](../../AGENTS.md)。本文件说明实现边界；历史单次授权、分组发布与旧预算不再作为默认规则。

- 每PR只在首次opened跑一次Light，后续任何修改、元数据和重试均不重跑；必要 Review 后冻结候选，显式选择最终 Quick 或 Full。无关正文/同模式标题编辑不分配校验 runner，也不取消已有最终请求。
- Quick 不运行 PostgreSQL、恢复、打包或现场验收；Full 按实际 base→candidate 风险执行所需领域。未知执行风险不能当无风险。最终批准绑定准确 Head/base、等级、run/job/attempt 及实际回执。
- 请求 ref 不可变，不删除重建、force、更换nonce或用noop触发。相同请求先 reconcile。过期 Head、失败、取消、全skip、空计划和缺阶段均不能签成功。
- 实际预算由 `.github/workflows/ci.yml` 和 `full-gate.yml` 维护，文档不复制另一组值。超时先定位阶段和资源，不直接加大全局限制。

当前Head没有可复用Light时，最终Quick/Full照常执行原检查，不以旧Head证据冒充新Head成功。保持准确Head/base和原门禁回执，不修改平台保护。

## 同Head light→Full复用

`scripts/ci/light-reuse.mjs` 发布源快照，最终Full读取 GitHub 的实际成功 light run/job 和唯一回执，下载该 run/attempt 的唯一不可变 artifact。读取需要本仓库最小 `actions: read`；不增加token写权限、仓库保护、生产秘密或安装授权。实现遵循[GitHub Artifact API](https://docs.github.com/en/rest/actions/artifacts)与官方[下载动作](https://github.com/actions/download-artifact/tree/v4)。

可复用项仅为同语义的 lint、typecheck、workspace build、迁移静态检查。Head、实际base、PR/等级、树/锁文件、Node/npm、runner镜像/平台、声明的构建环境必须一致。源快照不是最终Gate回执；源Job最终成功且服务端实际检查成功才可采用。

产物逐文件校验内容、路径和权限，禁止跳目录、覆盖tracked源码、符号链接或未验证内容。源缺失/不适用/环境变化会执行真实原检查；损坏产物与伪造来源拒绝。每个采用项保存源run/job/attempt与指纹，最终核证还要与当前已核light对照。不是把skipped同名检查变绿，不跨Head复用；完整历史secret扫描、生产依赖审计、业务测试、DB/恢复保持各自语义，不拿light替代。

## 受管PostgreSQL

本分支 canonical plan 和资源契约规定文件集合、配置、真实DB身份、共享注册与精确清理。mapped/chain/Root同上下文并集只执行一次；不同版本或恢复环境不得复用。参数由共享执行配置维护，记录实际解析值，不能靠机器核数默认。

并行worker交回重型schema，全部退出后父runner按同manifest顺序实际删除；交回不等于删除。立即删除契约和独立本地模式仍真实删除。失败保留清单，不扫描/通配猜归属。测试不得因缺资源接线、清理失败或被中断而签passed。

## 证据与例外

summary按实际outcome列成功、失败、取消、不适用及未执行。render/清理成功不等于Gate成功。操作者核证不是平台保护；未知服务器设置保持未知，不擅改required checks。用户明确接受某PR剩余风险而直接合并时，保留失败、未验范围和原文来源，绝不伪造Gate成功；该单次决定不扩大成长期豁免。

Review服务恢复、连接器/CLI传输差异及有效授权按[协议](review-first-final-head-20261027.md)处理，不为无关平台波动重复跑全部业务检查。

## 2026-11-15 PG16 备份恢复演练环境

#995 Full43703571054 已运行的业务及数据库测试通过，但 ubuntu-latest 实际切换为 Ubuntu26.04，演练恢复在 `SET transaction_timeout = 0` 失败。汇总如实拒绝，后续生命周期和打包未执行，不当成通过。该 runner 的[官方软件清单](https://github.com/actions/runner-images/blob/ubuntu26/20261111.196/images/ubuntu/Ubuntu2604-Readme.md)列 PostgreSQL18.6；[PostgreSQL 官方说明](https://www.postgresql.org/docs/18/app-pgdump.html)不保证较新 pg_dump 的输出可以回灌旧版本服务器。

Full 固定使用 Ubuntu24.04；PG16 演练通过原支持的 `DX_REWORK_PG_BIN_DIR=/usr/lib/postgresql/16/bin` 为备份和恢复选择同一套客户端，实际校验/记录三个工具及服务器均为16，不再依赖 PATH 中的默认客户端。工具缺失或版本不符在创建备份前拒绝；原生产脚本、校验和、隔离身份、空目标、单事务/出错终止和 schema readiness 检查保持。没有剔除 dump 语句、吞恢复错误、跳演练或改生产配置。真实隔离 PG16 通过原脚本备份/恢复、232条迁移ledger和额外测试行核验；本地只适配CI机器路径及Git元数据，不代表已验证新的GitHub镜像运行，仍由准确新head的Full完成。
