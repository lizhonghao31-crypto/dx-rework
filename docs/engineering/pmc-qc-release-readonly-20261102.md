# release PMC只读接线与QC验收消费者修复

## 目标、基线与授权

- 仓库 `lizhonghao31-crypto/dx-rework`；仅合入 `release/digital-production-v1`。
- 精确base `5e3b36f51706570debec412f6dce5a5152feae42`，tree `865bc2f0624de29e6bca14df8e858047b89bcdaf`。
- Work分支 `fix/pmc-qc-release-work-20261102`；FULL。原Chat已由用户于2026-11-02 16:03:38 UTC确认停止，用户授权Work接手PR、必要Review、最终Gate和合并。
- main的PMC与维护更新已完成，不重做main、不部署、不改Acceptance/生产数据或真人权限、不恢复现场验收。
- 用户明确只完成权限闭环；性能治理和测试清理能力建设不在本PR范围。

## 原材料与恢复边界

已实际材料化并核ZIP SHA256、候选/基线/证据逐文件hash：

|材料|校验和|内容|
|---|---|---|
|preserved-20261102T151259Z|`a2ad14d4d8d27b2ba9742bd8e94a3d2b8c8229d6d02be7934bd03237686de2b3`|84源码、78基线、256证据；性能分离前|
|current-20261102T140333Z|`2d0ab684a96ae036564471fc64b23c06726ef79af8aa5b46f28f2f3e3ac84641`|80源码、202证据；77源码与84包完全相同|

两包按差异精确恢复，未从摘要重写业务。旧Chat声称的最新81文件/Tree未取得且GitHub返回404，不能宣称本候选等于该冻结稿。Native Git重新取得实际base，78个基线文件hash匹配、patch apply检查通过；41个跟踪PNG由原Git对象完整检出，没有重画/替换/删除。

## 本PR业务闭环及影响消费者

1. 选择性复用main PMC固定23项能力、身份装载、字段/附件/私有导出及HTTP纯PMC禁写；Root和真实多角色保留原岗位。原Lab三个精确控制POST仍独立核控制凭据，邻近/时钟/业务路径不豁免。
2. PMC旧模块读取包括供应商、生产、裁床、板房、返工判责及工资历史/导出，写命令和金额/归属边界不变。
3. 数字域单独使用 `isDigitalManagementReader` 读取生产管理批准范围，不将PMC放入共用写判断 `isDigitalLeader`。计划申请/采用、派工、制单、质量/结案等原写能力不扩大。PMC+板房员工本人的原任务入口保留，不因摘要只读抹掉实际岗位能力。
4. QC仍需quality_control和qc-production-progress及真实任务/厂单/PO/照片/scope；不整套获得reporter、完工/发货、仓库改数或Root订正权。旧矩阵production403期望改为新批准读取，不放宽旧标准身份。
5. 纯身份验收绑定exact userId和唯一预期角色；未知、缺身份、污染和未执行不能算通过。真实多角色单独验，同cookie撤权不得用Lab切换吊销替代。
6. 以上影响表的实际写/读入口、旧测试、初始化/权限边界及命令证据见同批 `construction-evidence.json`。原预算总额、C/P日期、制单与数量/质量业务规则均不改。

## 撤出性能范围及测试预算

- 两项factory scopes/return logistics空关联预读guard已从候选撤出，两源文件逐字恢复base；专用factory/task-read-boundary测试恢复base，PMC unit中仅去掉对应预读mock。
- 完整原84包和7文件差异保留在任务恢复证据，不删除原成果、不另开性能PR。
- full-chain P07/P08原显式30000ms恢复；Journey旧Root HTTP恢复原默认5000ms。原120000ms分页总约束保留，不能按分段预算替代总约束。
- Journey的finally恢复spy、共享夹具失败后不继续执行依赖用例、owned schema交回保留。这些不取消已执行Promise，也不把skip算通过。

## 当前可复用的真实验证

当前恢复源码逐项重新计算原声明inputPaths指纹，并核原日志和报告字节摘要；以下均匹配，不冒称在Work重跑，也不把祖先testedHead当已提交候选Head：

|原记录|真实结果|当前输入匹配|
|---|---|---|
|permission-targeted-1|26文件326 passed/0 failed/0 skipped|`35c8d08f1b67d20304bac6780b201b0e23057d766576760323a15107b3b15862`|
|role-qc-pg16-2|真实身份session8＋QC9，17/0/0|`cfb4888be992b308f4080894c7f12e872b4d99868d1b2363e39d84fdb4391928`|
|build-1|workspace build exit0，非根postbuild|`652f4b243a4002d7efaf99dc04bbf4985c8609f3ffa871dc979065d55edb05a3`|
|typecheck-1|workspace typecheck exit0|同上|

原执行环境Node22.22.2/npm10.9.9，PG16.15；当前Work Node22.23.4仅执行本轮实际命令。跨环境结果不称硬件等效。Work仅为后续检查生成共享包产物，没有重新运行完整app构建。

Work范围收窄后的原生预检152/0/0已实际通过；最终Lint、机械证据、新Head检查分别记录。没有新增CSS/布局或伪造浏览器/现场验收；现有UI正反例为真实SSR/组件及模块读取测试，不能扩大为现场视觉通过。

## 失败、未测及证据限度

- 原full-chain60/60使用过P07的60秒预算，不可当恢复30秒后的整链通过；原结果作为历史事实保留，不写为当前有效full-chain检查。
- 原PG13分页有120秒失败，旧Root HTTP在base也出现默认5秒失败；有插桩/前序迟到的205s与145s不可比，不据此宣称性能退化或改善。未重做配对诊断、查询缓存或系统性能修复。
- 两项性能guard减少约1.8%调用但仍超时，不属于本PR通过证据。没有借此扩大timeout、删除分页/权限/数量断言或改变CI。
- Work本地一次只读数据库安全探针先因外部辅助入口文件名错误未加载，随后无密码连接被自有PG16的SCRAM认证拒绝；没有执行套件或创建schema，没有读取旧凭据/改密码/改HBA。该探针不是测试通过，也不影响上述准确输入的17项原PG证据复用。
- 在上述边界下继续完成draft PR和一次必要Review，不因性能诊断未完成而阻止创建PR。最终原有Gate仍须真实执行；若失败给具体结果和最小选择，不自动扩修全系统性能、不冒称通过。

## 交付纪律

维护准确Head/base，light后一次GitHub Codex Review，集中修复；父级本批定点闭合后以V3.1 closeout请求最终Gate。只在准确Head证据满足时按授权合release，不调用GitHub APPROVE，不合main、不部署。PR、Review、Gate和合并回执在原PR补记，不为补结果另造noop提交。
