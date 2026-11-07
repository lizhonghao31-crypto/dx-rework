# Acceptance阶段容量估算修复

用户2026-11-07明确要求修复20.97 GiB下载预估拦住19.64 GiB可用空间的规则，不清现场空间。独立分支 `fix/acceptance-capacity-stage-budget`，实际远端release基线 `e3595325a35f876aa0d24ac59800749beb7958dd`；允许本独立修复验证、创建PR、Review并合并。不部署、不读取现场密钥或改现场配置/数据；PR03/PR04成果留各自本地分支，不推送。本变更为部署工具，使用FULL，保留既有工具变更演练。

|批准规则/来源|实际入口与消费者|初始化/历史及失败边界|必要检查|
|---|---|---|---|
|用户要求纠正阶段间重复计费|acceptance-capacity.components→main→dx-acceptance.capacity_check，fetch-update-source的archive预检|fetch子进程EXIT清临时Git库；主控prepare必先重查build；archive时已占用Git由实际available计入，不假算释放空间|真实Python估算器边界、实际controller worker派发与原update-flow串联；download/archive成功但build/backup/stop不足均在stop效果前拒绝|
|Acceptance匹配锁依赖可作为估算依据|components读取生产/Acceptance现有lock和node_modules大小，仅计算预算|完全匹配且已安装才用实测大小+50%，最低512MiB；不匹配/缺失保留2GiB底线；原安装/复用/完整性校验不变|旧生产lock、新Acceptance匹配；不匹配与缺失；原更新器依赖及信任策略回归|
|原生产/数据保护不放宽|inspect-storage、build/backup/stop、生产锁/健康/备份/失败恢复入口|download/archive仍核固定DB/storage；后续rewrite、WAL、日志、备份与operating headroom原样；显式install后diagnose/update，非旧工具data-only绕过|原容量/存储、更新编排/策略/源码验证及部署契约；静态、Review、最终FULL另按真实回执记录|

已运行Python16项边界与py_compile，均退出0；其余实际结果收口后补录，未称现场或Full通过。

冻结源码本地验证：preflight249/0/0；定向Vitest56/0/0（其中容量原入口实际执行Python16项，并追加原worker/flow串联3项）；全工作区typecheck/build、lint、secret scan均exit0。准确命令、时间、源码指纹及日志摘要保存在同提交construction-evidence.json，私有原始报告 `/workspace/scratch/m01-capacity-unit.json`。早期测试包装字符串转义错误已修，不计为通过；py_compile生成的私有编译缓存已移除，最终记录绑定清洁候选源码。现场仍未操作，旧20.97GiB不直接换算成承诺新阈值。
