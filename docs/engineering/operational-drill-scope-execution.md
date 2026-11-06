# 日常 PR 的模拟迁移和恢复演练范围

用户已批准取消日常业务 PR 强制模拟迁移和恢复演练，迁移/备份工具变化及发布前按需运行。最新转交确认 Acceptance 已更新到 0e2692e39f0d000a566ed025947528fba324e87e，可在检查通过后合并；不部署生产、不操作现场诊断、真实库或备份。

本任务目标 release/digital-production-v1，实际远端/base 为 0e2692e39f0d000a566ed025947528fba324e87e，独立分支 ci/operational-drill-scope，按 FULL 检查。完成标准：普通业务 SQL、随附迁移清单及测试映射不再自动选择历史升级/维护/恢复演练；真实迁移、备份及未知部署执行器变化继续覆盖；数据库初始化、静态校验、业务链、Root、真实现场发布要求不变。

实施前影响记录：用户批准规则 → full-gate-risk-map.classifyFullGatePaths 的 migration/maintenance/activation/transfer 与 mappedPostgresTests → CLI 环境输出、ci-gate-runtime.scopeFor/scopeRequired、full-gate-lanes.expectedInputs、test-suite-plan.fullGatePostgresPlan → 原 Full 工作流各步骤条件、聚合/最终认证及同源 summary。普通 SQL 必须继续要求真实 DB/业务链/Root，但不能顺带加入 migration-compatibility-postgres 历史升级矩阵；迁移工具修改则保留该矩阵及恢复演练。共享门禁映射仍要求 FULL 和真实业务链，不等于修改部署执行器。

定向验证使用原 full-gate-risk-map Vitest、gate-maintenance node:test、原 preflight；反例覆盖 SQL+清单+映射混合、实际工具正例、未知部署执行器、顺序/重复路径，以及真实 CLI → scope → canonical plan → summary 的不适用与失败区分。执行后补实际命令、来源、计数和日志摘要到当前 construction-evidence；不把不适用步骤写成已通过。

实现移除普通 SQL/四类迁移清单自动附加的历史升级矩阵和 maintenance 扩展；已知共享门禁保持 FULL/真实业务链，实际 Full 运维执行器仍保守覆盖。原演练、现场诊断及备份/部署脚本未修改。assembled 来源 b930abbd46f25d7d88f45058a988b348113f64b8a4c0477476b96867ac6f54d0：preflight 249/0/0、风险映射单元 56/0/0，typecheck、workspace build、lint、secret 均退出0；Node22.22.2/npm10.9.9，native并发2/Vitest worker1，本地CPU有界，不宣称CI硬件等效。初次预检的过时恢复断言及新增summary断言差异已集中修正，原失败日志保留，不计通过。最终light、唯一正式Review、Full及合并按准确候选另核。
