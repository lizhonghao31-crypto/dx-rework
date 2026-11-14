# GitHub Actions 执行政策 V4

长期规则见[AGENTS §4–5](../../AGENTS.md)。本文件说明实现边界；历史单次授权、分组发布与旧预算不再作为默认规则。

- 每PR首次opened只跑一次light；后续push、重开、编辑及重试不再跑light；必要 Review 后冻结候选，显式选择最终 Quick 或 Full。无关正文/同模式标题编辑不分配校验 runner，也不取消已有最终请求。
- Quick 不运行 PostgreSQL、恢复、打包或现场验收；Full 按实际 base→candidate 风险执行所需领域。未知执行风险不能当无风险。最终批准绑定准确 Head/base、等级、run/job/attempt 及实际回执。
- 请求 ref 不可变，不删除重建、force、更换nonce或用noop触发。相同请求先 reconcile。过期 Head、失败、取消、全skip、空计划和缺阶段均不能签成功。
- 实际预算由 `.github/workflows/ci.yml` 和 `full-gate.yml` 维护，文档不复制另一组值。超时先定位阶段和资源，不直接加大全局限制。

## 同Head light→Full复用

`scripts/ci/light-reuse.mjs` 发布源快照，最终Full读取 GitHub 的实际成功 light run/job 和唯一回执，下载该 run/attempt 的唯一不可变 artifact。读取需要本仓库最小 `actions: read`；不增加token写权限、仓库保护、生产秘密或安装授权。实现遵循[GitHub Artifact API](https://docs.github.com/en/rest/actions/artifacts)与官方[下载动作](https://github.com/actions/download-artifact/tree/v4)。

可复用项仅为同语义的 lint、typecheck、workspace build、迁移静态检查。Head、实际base、PR/等级、树/锁文件、Node/npm、runner镜像/平台、声明的构建环境必须一致。源快照不是最终Gate回执；源Job最终成功且服务端实际检查成功才可采用。

产物逐文件校验内容、路径和权限，禁止跳目录、覆盖tracked源码、符号链接或未验证内容。源缺失/不适用/环境变化会执行真实原检查，不能为此补跑Light；损坏产物与伪造来源拒绝。每个采用项保存源run/job/attempt与指纹，最终核证还要与当前已核light对照。不是把skipped同名检查变绿，不跨Head复用；完整历史secret扫描、生产依赖审计、业务测试、DB/恢复保持各自语义，不拿light替代。

## 受管PostgreSQL

2026-11-06 用户批准调整模拟演练的适用范围：普通业务 SQL、migration-manifest、acceptance-migration-requirements 及随附测试映射不再自动选择历史升级矩阵、Acceptance 维护及备份/恢复演练。静态迁移校验、新鲜隔离测试库的真实迁移、业务链和 Root 检查继续按原风险执行。共享门禁选择/回执代码仍要求 FULL，但不因维护映射而附加运维演练；实际 Full 运维工作流、未知部署执行器保守覆盖。

修改迁移执行/历史政策、备份/恢复工具或实际部署执行器时，仍由风险映射选择原相应演练。发布前可按实际风险使用保留的 migration-compatibility-postgres 套件及 acceptance-maintenance-drill/main-release-history-drill 等原入口，在受管隔离环境运行；本次不创建定时任务或自动现场操作。CI 不适用步骤报告为不适用，不能称已通过。此调整不修改实际部署前现场诊断、权限核查、备份或失败恢复要求。

本分支 canonical plan 和资源契约规定文件集合、配置、真实DB身份、共享注册与精确清理。mapped/chain/Root同上下文并集只执行一次；不同版本或恢复环境不得复用。参数由共享执行配置维护，记录实际解析值，不能靠机器核数默认。

并行worker交回重型schema，全部退出后父runner按同manifest顺序实际删除；交回不等于删除。立即删除契约和独立本地模式仍真实删除。失败保留清单，不扫描/通配猜归属。测试不得因缺资源接线、清理失败或被中断而签passed。

## 证据与例外

summary按实际outcome列成功、失败、取消、不适用及未执行。render/清理成功不等于Gate成功。操作者核证不是平台保护；未知服务器设置保持未知，不擅改required checks。用户明确接受某PR剩余风险而直接合并时，保留失败、未验范围和原文来源，绝不伪造Gate成功；该单次决定不扩大成长期豁免。

Review服务恢复、连接器/CLI传输差异及有效授权按[协议](review-first-final-head-20261027.md)处理，不为无关平台波动重复跑全部业务检查。

## 完整非DB与PG独立执行（PR1）

Full由公共准备、完整非DB、完整PG和最终聚合组成。公共准备仍核准确请求、风险、现有light来源、构建与静态检查；两个测试job只依赖该准备job，各自从准确Head检出并锁定安装。共享构建快照绑定head/base/PR、run/attempt、源码树/锁文件、Node/npm、镜像及构建环境、构建时间、风险和规范文件计划；下载后核整个快照摘要与逐文件内容、路径及权限，再恢复，拒绝tracked覆盖与符号链接。PG初始迁移、角色与各版本/恢复演练继续在其自己的隔离环境内执行；它不接收非DB测试产生的文件或数据库。

PG canonical普通/immediate/long顺序、worker、测试时限、mapped/chain/Root去重和cleanup规则保持。Full concurrency移到已完成事件选择的调用job，覆盖整个可复用工作流，避免兄弟job争用同一组而互相串行或取消。每个实际执行job有有限预算；最终聚合只有元数据操作。拆分后的各job预算不是原单worker总墙钟上限，不能把预算值当实测耗时。

最终聚合要求所有job实际成功、独立lane回执同一请求/run/attempt/共享构建摘要、完整且无重叠的原检查分区；按原风险规则拒绝缺项、失败、取消和必需检查skip。PG沿用原receipt的计划/上下文/cleanup核验；原生非DB JSON及PG receipt（含原执行结果）分别留为artifact。上传或汇总失败也不签成功，之后的原最终认证继续校验完整tuple。

证据边界：该改造保持执行命令、文件集合与业务断言，不建立第十六节建议的独立case期望目录。v1 PG receipt仍只证明文件计划、每文件至少一项通过和清理；不能宣称所有应有case已完整执行。非DB原有acceptance PG文件无TEST_DATABASE_URL时的11项skip仍单独披露，不升级为PG通过或新增豁免。PR2的选测、分片、case目录或重试复用另定范围。没有同范围实际运行数据前，不报告提速比例或费用下降。

### 托管镜像滚动更新与本地重建

Full 固定使用 ubuntu-24.04 OS 标签；标签仍可能分配不同周版镜像，不能保证 ImageVersion 相同。跨 runner 恢复仍要求完整环境指纹相等。只有同一 OS 的非空镜像版本不同、其余源码树/锁文件/Node/npm/平台/架构/构建参数完全相等时，lane 才能转为本地重建：先校验原快照及全部路径和内容，清除已核合法的 dist 输出，再执行完整 workspace build；不恢复该快照的构建文件、不复用构建成功状态。镜像 OS 或其他输入不同仍拒绝。

本地构建成功后记录其真实环境、输出文件摘要及原快照来源；测试结束再次核环境和输出未变。聚合要求每个 lane 的构建凭证与共同请求及来源匹配，区分 restored 与 rebuilt，缺凭证、失败重建、篡改或环境漂移均拒绝。此路径保证测试使用本 lane 环境生成的产物，不声称不同镜像字节等效。重建有额外成本，不是放宽跨镜像产物复用，也不是自动重试 CI。
