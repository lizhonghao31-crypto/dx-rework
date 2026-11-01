# Acceptance Lab 固定运行手册 V1.0

状态：长期执行基线  
适用仓库：`lizhonghao31-crypto/dx-rework`  
建立日期：2026-09-30  
用途：A1/A2/A3/A4阶段验收与后续同类Acceptance回归

> 目标：以后任何Work窗口进入Acceptance阶段时，直接按本文执行，不再重新设计部署链路，不再重复ENV建设，也不把控制码/浏览器问题误判为部署失败。

## 1. 当前固定环境

| 项目 | 固定值 |
|---|---|
| 生产 API | `127.0.0.1:3201` |
| Acceptance API | `127.0.0.1:3202` |
| Acceptance 数据库 | `dx_rework_acceptance` |
| Acceptance DB运行角色 | `dx_rework_acceptance_app` |
| Acceptance Linux运行用户 | `dxacceptance` |
| Acceptance canonical root | `/opt/dx-rework-acceptance` |
| 公网入口 | `https://staging-api.dxerp.org.cn/acceptance` |
| 公网 API 基址 | `https://staging-api.dxerp.org.cn/acceptance/api/` |
| 前端 canonical | `/opt/dx-rework-acceptance/frontend/current` |
| API canonical | `/opt/dx-rework-acceptance/current` |
| PM2用户 | `dxacceptance` |

生产3201、生产数据库、生产Nginx主站不得因Acceptance操作被修改。

### A1已经完成的一次性建设

以下事项后续A2/A3/A4不得重复：

- 独立DB与低权限DB用户；
- 本机HBA；
- `dxacceptance` 用户与canonical目录；
- 0600 Acceptance `.env` / `deploy.env`；
- Nginx `/acceptance` 路径指向canonical前端和3202；
- 旧root运行的Acceptance 3202清理；
- canonical API/Frontend首次安装与active链接；
- 生产3201与Acceptance 3202隔离。

## 2. 明确废弃 / 禁止恢复的方向

后续Work不得重新建设：

- GitHub Hosted Runner通过公网SSH直接进ECS；
- 为此扩大公网22端口；
- self-hosted Runner作为业务施工前置（#587方向）；
- 每个PR逐个部署Acceptance；
- 同一台ECS上“候选目录 → tar → 再解包”的本地传输路径作为默认部署；
- 直接把整个候选 `node_modules` 软链到 `/opt/dx-rework/source/node_modules`；
- 在2核2G ECS上重跑Full Gate。

Acceptance只按业务批次部署：A1=P01–P04，A2=P05–P08，A3=P09–P14，A4=P15–P16+最终候选。

## 3. Acceptance 必须存在的运行参数

`/opt/dx-rework-acceptance/shared/.env` 必须满足：

```text
APP_BASE_PATH=/acceptance/
ROOT_DINGTALK_USER_ID=uat-root
ACCEPTANCE_LAB_ENABLED=true
DIGITAL_PRODUCTION_ENABLED=true
DIGITAL_PRODUCTION_CREATION_ENABLED=true
TODO_RUNTIME_ENABLED=false
TODO_DELIVERY_ENABLED=false
TODO_TIMING_ENABLED=false
```

同时：

- `DATABASE_URL` 必须实际连接本机 `dx_rework_acceptance`；
- 不允许Acceptance配置真实OSS副作用参数；
- 不允许 `OPENAI_API_KEY`；
- 不允许开启真实钉钉Todo runtime/delivery/timing；
- 真实secret、密码、session secret、Acceptance Lab secret不得写入仓库。

## 4. 每一批Acceptance固定流程

### 固定更新入口与恢复边界（2026-10-03 修复方案）

本节定义仓库工具的交付行为，不代表服务器已经安装此版本或已经恢复。PR615 已关闭未合并；现场曾安装其衍生脚本并有本地修改，不能把 `247ccd0` 源码当作现场完整脚本。

经审核的 `bash scripts/dx-acceptance.sh install <已核准的40位工具SHA>` 安装完整、不可变的工具版本到 `/opt/dx-rework-acceptance-tools/<工具SHA>`，并原子替换 `/usr/local/bin/dx-acceptance` 与 `/usr/local/bin/dx-rework-update` 两个入口；第二入口失败会恢复两者。安装来源必须为干净且经 Gate/Review 核准的完整远端 checkout，预期 SHA 不符时不得安装。安装或升级工具是显式运维步骤，不由常规更新偷偷执行。工具版本与业务候选版本分别记录；工具不再从旧业务候选中寻找新维护脚本。

后续单一入口为 `dx-acceptance update <已核准的40位候选SHA>`。省略参数时先解析集成分支当前 SHA 并固定该次运行；生产源码只用于既有认证的 fetch/archive，不 checkout、不构建、不部署生产。只有此前通过 Gate 的集成候选才可交付执行。

顺序固定为：生产实际运行保护 → 本机 Acceptance 配置/实际 DB 身份及下载前容量预检 → 固定候选下载与解包前复核 → 明确 Acceptance 意图的候选源码完整性检查（main 差异列为未验证发布待办） → 依赖/构建前容量复核与完整性校验 → Acceptance 自身实际历史与配置检查 → 实际维护角色只读权限预检 → 备份前容量复核与数据库备份 → 停服前容量复核 → 停止Acceptance → 重新检查历史/身份/权限并迁移 → 同代前后端切换 → 本机/公网及 PM2 持久化验收。任何构建、配置、权限、备份失败都不得先停止原服务。

下载前只允许固定 catalog 元数据读口，不提前导出生产历史或读取业务行：先由原应用连接读取本机数据库名、实际 port/OID、current/session role，Root 固定为不可写证据；随后 Root 通过既有本机 postgres peer 边界，以只读事务和固定 SQL 核同一数据库身份并读取本库体积、数据/表空间、WAL、日志实际位置。语句/锁/连接均有限时。不向应用授予 `pg_read_all_settings`、不改变 owner/成员/ACL；任意身份变化、权限失败或不可读容量均拒绝，不回退到猜测值。迁移仍在原固定 owner 下执行，原 source 兼容检查仍在历史导出、构建、备份、停服和迁移之前。

复用 PR615 的依赖准备、打包、历史校验和资源验证。新的业务候选始终从同一 SHA 构建 API 和 Web，禁止复制旧前端改 manifest。只有具有当前工具产生的构建来源记录、候选 SHA、前端来源 SHA、完整 checksum 的整个候选包才可复用；现场旧候选缺少来源记录时应在停服前拒绝，由运维审核后另行处理，不能自动覆盖已存在的 release。

`acceptance-migration-requirements.json` 是与原 SQL checksum 绑定的本批迁移权限清单。预检在真实维护角色下、只读事务内检查 public CREATE、涉及旧表/函数的所有者能力、外键 REFERENCES 和数据写权限，并一次输出所有对象的 owner、ACL、应用有效权限以及维护/应用角色继承关系，再统一决定是否拒绝。不修改任何授权，不要求自定义 default ACL。未知待执行迁移或清单 checksum 不符时先补审核清单，不能跳过。迁移前在同一 advisory lock 下再次预检；迁移仍逐项提交，原文件名、checksum、applied_at 不得更改。

在每个待执行迁移的事务内，先记录已有关系OID，执行原始SQL后按catalog核对实际新增表和序列与清单完全一致；遗漏或多出对象即回滚该项。仅对该项实际新建且清单明确列出的表授予应用 SELECT/INSERT/UPDATE/DELETE，对本项实际新建且明确绑定表/列的IDENTITY序列（包括ALTER既有表新增IDENTITY）授予备份所需SELECT，然后记录原迁移checksum并提交。不会对已执行迁移重新授权、改变现有对象owner、设置默认授权或扩大角色成员关系。IDENTITY自动编号不要求应用具备序列USAGE；现有应用连接执行的pg_dump却需要序列SELECT，不能用USAGE替代。

正式只读诊断入口为 `dx-acceptance diagnose <40位候选SHA>`。它使用已安装工具，复用现有认证fetch/archive，在本机产生临时证据并取得运维锁；数据库只读，无候选构建、备份、PM2操作或迁移。权限不满足时完整报告仍输出并返回失败。成功只表示该时刻维护前置条件通过，不表示已部署或业务已验收。

`diagnose` 不自动刷新工具；新执行策略、依赖或 infra 改动仍必须经显式 `install`。`update` 的 data-only refresh 仅限原 validator 证明全部执行代码/锁依赖一致且冻结迁移/checksum 不变的情形，不能拿新源码替换已安装信任策略。

角色报告同时输出实际 `server_version_num` 和成员角色的 `member_rolinherit`。PostgreSQL 16 以前不存在逐条成员关系的 `inherit_option/set_option`；对应报告值为 `not_applicable`，不能解释为 false。有效继承与所有者能力仍使用服务器真实 `pg_has_role(...,'USAGE')` 判断。README 的标准环境要求仍为 PostgreSQL 16；本工具已有 PG15/16 真实诊断、迁移及备份恢复回归，本轮另以实际 PG13.23/16.15 和 Python3.6.15 验证固定存储查询、原维护与隔离恢复；不表示已支持所有其它早期版本。现场缺少 PG16 catalog 列只能证明该列不可用，不能仅凭客户端路径或此错误断言服务器就是 PG15。

每个实际挂载分别按剩余工作预留源码/独立 Git 对象库与认证源码库 fetch 增量、工具 staging、锁依赖/缓存/解压临时集、build/candidate/API release/前端 release、在线备份临时集、数据重写、WAL 与日志余量；现存旧代和备份占用不抵扣。逐卷记录 available/required/shortfall 与真实探针路径，任一卷不足在对应重操作前拒绝；不自动删备份、清历史或扩盘。估算不是空间预留，也不能保证并发写入不耗尽余量；后续阶段仍需复核，精确公式见 [PR6 工程记录](../engineering/acceptance-delivery-capacity-pr6-20261027.md)。原备份后至少256MiB/本库大小的停服前检查继续保留。

备份在停进程前完成；它是在线一致性快照，不承诺包含其后的业务写入。迁移历史相同、PM2 当前 stopped，均不能证明备份后没有业务写入或期间未重启；因此新版不自动复用旧进程留下的备份凭据。每次确有更新的调用只备份一次，已是同候选且 schema current、运行验收健康的调用只验证、不重启、不备份。若此前激活失败后候选已停止，同SHA重试核验候选/配置/完整schema后仅重新激活该候选，不重跑迁移或备份，不切回旧代码。保留所有既有备份。额外记录对象 owner/ACL 供恢复核对；现有 dump 使用 `--no-owner --no-acl`，并不自动重建原授权。

`shared/attachments` 永不清理或随 release 覆盖。数据库回退若需要匹配历史附件，必须另行核实时间点及附件保全，不能只恢复数据库然后宣称附件一致。当前更新工具没有自动回库功能；现有 `restore-postgres.sh` 仅允许隔离演练库，不得放宽其目标限制。

每次尝试写入 `logs/update-<SHA>-<时间>-<PID>`，记录初始进程状态、旧 SHA、完整迁移历史、备份及阶段。失败时保留 root 控制的候选 SQL/现场历史临时证据路径，不输出凭据。

预检证据在 `.acceptance-preflight` 中逐阶段记录，worker 开始后复制到上述日志目录；首次失败尚无 worker 时保留并输出 root 临时证据路径。PM2 live 与 `pm2 save` 后的 dump 都必须仅有 Acceptance API，cwd/script 指向 `releases/<同一SHA>`，不得通过可变 `current` 作为重启依据。公网验证通过后才持久化并核 saved 路径；任一失败仍失败并停止候选，不自动修复旧 dump、旧 owner 或 root PM2。此前旧代恢复也只在原完整历史不变等条件成立时，由新工具明确 pin 旧 SHA；不改写旧 release。

#### Acceptance 单进程不可变路径切换

PM2 6.0.14 的同名 `startOrReload`、普通 restart 和 `--cwd` 均不能保证重算旧注册的 `pm_cwd/pm_exec_path`。更新器因此只在数据库迁移完成、完整 manifest/readiness 校验通过并选择新 generation 后，重建**已确认 stopped、身份唯一的 Acceptance API 注册**，使用精确 PM2 ID 删除；不删除 daemon、其它应用或生产槽。PM2_HOME 固定为 `/home/dxacceptance/.pm2`。不能在普通 update 之前手工删除注册，否则原 prepare 无法读取初始状态。旧 legacy `current` 注册仅允许停止和替换，不据此启动旧代码；实际新启动和最终 runtime guard 仍须全部指向本次不可变 release。

备份仍先于停服和迁移。停服阶段保存并核对 `dump.pm2` 及其 `.bak` 都为 stopped 后才允许迁移，避免 daemon 重启回退到旧 online 记录；**online 候选的保存仍只发生在原本机/公网完整验证之后**。新启动失败时，helper 只注册 `autostart:false` 的目标占位并保持 stopped，不执行旧代码；原失败仍返回失败，阶段及配置证据保留。同 SHA 再次调用原 update 时，须完整 schema 已 current、当前 generation 为该 SHA且注册明确 stopped，才沿原激活重试路径续跑，不重复迁移或备份；已健康且 saved 正确时保持无操作。不能只看末版本0265判断完整历史。

删除 stopped 注册之前，另写入 `shared/update-checkpoints/<SHA>.pm2.json` 激活记录，绑定固定候选 manifest、完整迁移历史、实际数据库身份、原 runtime 阶段及主/备用 stopped dump 的摘要。若进程被强制终止在删除后、启动前，原 update 仅在同 SHA/generation/schema、原阶段与所有摘要仍匹配、既有 PM2 daemon 存活且无其它应用时，重建 `autostart:false` 的目标 stopped 注册，再沿原激活路径续跑；不执行旧 dump，不重跑备份或迁移。没有该记录、版本/历史/身份/dump 任一不符均拒绝，不把一般性缺应用当作可自动修复。若中断发生于目标已 online 但尚未保存，原 update 必须重新完成本机/公网/生产验收，再保存与核 saved 路径，最后标记激活记录 verified。该记录不是旧备份复用凭据；保留原日志，不授权手工删注册或恢复旧代码。

验证或保存失败后，只停止 Acceptance API并验证 stopped 重启记录。若保存失败但已有主/备用 dump 都能证明 stopped，可保留该安全记录，整个更新仍失败；若连停止状态或持久化都不能证明，记录 `failed-runtime-state-unverified`，不得宣称已安全恢复或自动切旧代码。保留证据并先修复具体存储/进程异常。此处不授予 owner/ACL，不重seed，不改任何业务事实或旧TEST记录。

本修复新增执行策略，必须先从通过 Gate/Review 的干净固定版本完整 checkout 显式 `install`，再同版本 `diagnose` / `update`；旧工具的 data-only refresh 不得替换此策略。调用仍受原生产锁、Acceptance 更新锁及 release 锁保护，原生产实际 SHA/端口/health 保护不变。生产工具未新增 Python 参数，保持既有 Python3.6 兼容入口和 Node22。

可复现的独立本地验证：`tests/acceptance/acceptance-pm2-real.mjs` 接受已安装且固定6.0.14的 `PM2_TEST_CLI` 与私有证据目录；`acceptance-pm2-postgres.mjs` 另接受本地测试目标文件。它们只创建随机测试 PM2_HOME / 自有 PostgreSQL schema，不是现场运维命令。真实 PG13.23/16.15 的原流函数阶段、SQL事务回滚、pg_dump、278→279、失败激活与同SHA续跑已联合验证；HTTP、root及构建边界由另一个完整 controller/worker 离线夹具验证。本地结果不代表现场更新、公网TLS、实体业务验收已执行。

| 失败阶段 | 行为 |
|---|---|
| 准备/权限/备份 | 原服务不停止；无迁移 |
| 停止失败或历史在停服间变化 | 不继续迁移，报告失败，由运维核实状态 |
| 迁移失败，完整历史不变，原进程 online 且实际版本已核实 | 验证旧包/schema 后仅恢复同一旧 generation，并验证本机/公网/资源；整个更新仍返回失败 |
| 原进程已 stopped 或完整历史发生变化 | 不自动启动旧代码；保持停止，保留证据，走向前修复 |
| 迁移完成后激活、启动或公网验证失败 | 停止候选进程，保持新 schema，不自动切旧代码，不自动回库 |
| 全部通过 | 返回候选 SHA/schema；生产3201应仍 ready；另做业务验收 |

#### 已知现场故障与单表修复审批边界

已有现场证据：生产历史219项兼容检查通过；Acceptance225项/0225完整 checksum 校验通过；失败迁移三个新增列不存在。当前前后端目录标记为 `cb240e7…`，3202无监听；这些事实不能单独证明失败前进程实际运行哪个目录。恢复旧服务必须另行核实启动路径、旧包完整性与实际版本，不能直接执行 update 冒充恢复。

现有四表抽查中，`public.sourcing_contract_return_submissions` 已确认由 `dx_rework_acceptance_app` 持有，而数据库及另两张被检查表属于 `dx_rework_acceptance`。该错配使0218合同迁移因表所有权不足失败；它是唯一已确认的错配表，不证明其它待迁移对象无错配。历史迁移使用应用DATABASE_URL，新维护入口改为数据库所有者，这种执行身份变化需要结合实际对象owner和角色继承关系核对，不能认定是随机权限损坏。更新器只报告并拒绝现有对象的权限缺口，不自动转移所有权。

若业务负责人明确批准该具体修复，运维方案须在一个事务中核验目标库/实际端口/OID、225项完整历史及预期旧 owner，记录该表 ACL/依赖，锁定该表，再将**这一张表**交给既有维护角色，显式保留应用确实需要的业务 DML 权限；核验结果后提交。数据库身份不可只按名称判断，OID 用 bigint 明确序列化。不得全库 REASSIGN、授予角色成员关系、扩大应用 DDL 权限或超级用户跑全部迁移。此段是方案边界，不是现场执行授权或自动修复入口。

本地/CI使用冻结Git历史派生的219项前缀及225项前缀进行真实PostgreSQL回放；这不是现场导出的逐字节复刻。现场219项完整内容尚未纳入fixture，不能将220项样本或派生219项标为现场验证。服务器实际 updater 差异、实际旧启动版本以及候选/备份可复用性，仍是后续执行前需一次性收集的最小信息，不阻断代码侧修复。

#### 本次根因与验证范围

首次停机发生在旧衍生脚本停止Acceptance之后、OID类型检查失败之时，尚未执行迁移；随后owner失败延长停机。PG的OID直接放入JSON会输出字符串，正式工具已用bigint序列化。现场自定义default ACL为空并不是这些历史报错的原因，也不能证明应用过去无权限。旧脚本已有多处本地改动，不能用原始PR615源码替代现场实现；生产工作树SHA不是运行版本，PM2 dump也不是实时状态。

Full Gate新增独立、仅回环端口的PostgreSQL16容器实验：225历史、多个app-owned对象、无default ACL、应用不继承维护角色；Python3.6.15运行正式SQL生成器，通过真实psql执行，检查完整诊断、显式fixture修复、清单漏项回滚、部分提交失败及重试到236/0233。应用低权限连接执行真实母单/预算服务的创建、保存、读取、幂等及冲突检查；真实IDENTITY插入不需USAGE；复现USAGE-only的pg_dump失败并验证SELECT-only修复后的正式备份和隔离恢复。原225记录含applied_at和业务哨兵必须保留，default ACL保持为空。另从共同217项前缀执行全部清单迁移，覆盖六条IDENTITY序列，包含ALTER既有表的新增序列，并验证应用账号备份及重复执行。

该模型使用冻结Git历史及显式fixture权限，不是现场数据库/ACL完整克隆。它未运行ECS的PM2、Nginx、公网或真实附件恢复，不代表全部岗位业务验收。既有对象owner的精准处置仍须基于完整诊断，不能预先假定只有一张表。

只允许五阶段。没有新事实时不得插入额外“环境建设”。

### A. 锁定候选

1. 候选必须是当前批次集成分支的精确40位SHA。
2. 确认该Head所需Gate已绿。
3. 后续构建、部署、版本验证必须使用同一SHA。
4. Head变化后旧候选作废；不得只改显示版本号。

### B. 准备候选

- 优先在干净工作区/构建环境生成候选；
- 若ECS复用已有依赖，只能在 `package-lock.json` 完全一致时进行；
- 禁止把整个 `node_modules` 软链到生产源码目录；
- 如果复制 `node_modules`，必须验证 `@dx-rework/contracts/config/domain/ui` 最终解析到当前候选目录；
- Vite需写 `node_modules/.vite-temp`，候选运行用户必须有写权限；
- 构建成功后至少验证API runtime依赖与release manifest；
- 同一候选已经构建成功时，后续部署错误不得无理由重新build。

### C. 数据库与部署

- 当前批次存在migration时，每次确有更新的调用在停服前做一次Acceptance数据库备份；不得仅凭历史相同推断旧备份可以复用。同SHA且完整schema已就绪的激活重试按前述固定入口处理。
- 迁移前必须验证实际连接数据库名为 `dx_rework_acceptance`。
- 迁移只对Acceptance库执行。
- 允许短暂停Acceptance 3202；它不承载生产。
- 后续批次只管理当前 `dxacceptance` PM2进程；不得寻找或恢复已经清除的旧root Acceptance进程。
- 使用同机已验证candidate目录直接安装，不走无必要的本地tar传输。
- 数据库schema、运行API SHA、frontend manifest一致后才算部署完成。

### D. 技术验证

部署后只做一次必要验证：

1. `127.0.0.1:3202/health/ready`；
2. `127.0.0.1:3202/version`精确等于候选SHA和目标schema；
3. 公网 `/acceptance/api/health/ready`；
4. 公网 `/acceptance/api/version`与本机一致；
5. 公网Acceptance页面HTML和静态资源来自canonical frontend；
6. 生产 `127.0.0.1:3201/health/ready`仍正常。

六项通过后停止技术部署检查，进入业务验收。不要继续增加无关预检。

### E. Acceptance Lab 业务验收

见第5–7节。

## 5. 浏览器进入 Acceptance Lab

### 正确入口

当前Nginx使用精确 `location = /acceptance`，浏览器使用：

```text
https://staging-api.dxerp.org.cn/acceptance
```

当前不要把带末尾斜杠的 `/acceptance/` 当作入口。成功后应跳转到：

```text
/acceptance/ui/acceptance-lab
```

### 生成控制码

在ECS执行：

```bash
CODE="$(runuser -u dxacceptance -- env HOME=/home/dxacceptance \
bash /opt/dx-rework-acceptance/current/scripts/deploy/mint-acceptance-control-code.sh)"

printf '\n第一段：\n%s\n\n第二段：\n%s\n\n' \
"${CODE:0:90}" \
"${CODE:90}"
```

规则：

- 控制码有效期5分钟；
- 一次性使用；
- 两段粘贴到同一输入框时中间不要空格、不要换行；
- 终端自动换行可能导致只复制第一行，这是已知误操作风险；
- 控制码不得发进聊天、PR、Issue、日志或文档。

### “无效 / 过期 / 已使用”时

只做：

1. 清空输入框；
2. 重新生成一枚控制码；
3. 完整粘贴；
4. 5分钟内点击“进入验收中心”。

禁止因此重启Acceptance、重跑migration、重做数据库备份、重构建候选或修改Nginx。

## 6. 进入Lab后的固定顺序

### 第一步：版本确认

“验收证据报告”必须显示：

- Git = 当前候选SHA；
- Schema = 当前目标schema。

不一致才回到部署层；一致则继续。

### 第二步：确认本次验收范围

按业务负责人本次明确指定的范围执行。本轮A1要求在当前页面做业务验收，不运行自动角色权限矩阵，也不把矩阵结果代替真实业务办理。

本次范围包含权限回归时，再点击“运行全部角色权限矩阵”，记录通过、失败和标准待确认数；矩阵失败时看具体角色/规则，不直接重部署。业务范围不包含矩阵时记录 `role_matrix: not-run (business-only)`。

### 第三步：代表性浏览器场景

按页面现有场景逐个执行并保存证据。验收页面切换真实UAT业务Session，但不继承Root权限。

### 第四步：当前批次新增业务

自动矩阵不是当前批次全部业务验收。各批次还必须按施工计划执行新增业务端到端场景：

- A1：母单/PO、新旧隔离、权限、任务时钟、无SLA/动态SLA、站内待办；
- A2：开发单、物料、板房链、车板24h、尾查4h、工艺/洗水、复版；
- A3：预算、制单、外发批准、产前汇合、开裁、QC、发厂、回货返工装箱；
- A4：座舱、工序时效设置、双进度、数据沙盘、最终全链回归。

## 7. 故障必须分层，禁止“见错就全重来”

| 现象 | 所属层 | 正确动作 |
|---|---|---|
| `/acceptance/` 404，但 `/acceptance` 正常 | 入口层 | 用正确入口；不重部署 |
| 控制码无效/过期/已使用 | 控制层 | 重新生成完整控制码 |
| 角色矩阵某一项失败 | 权限/业务层 | 查具体规则和接口 |
| 公网version不是候选SHA | 部署层 | 查active/API路由 |
| schema不是目标版本 | migration层 | 查Acceptance DB migration |
| 3201异常 | 生产红线 | 立即停止Acceptance操作并优先恢复生产 |
| 前端HTML对但静态资源不一致 | Nginx/前端层 | 查canonical frontend alias和资源路径 |
| 待办列表500，数据库错误42501 | 数据库对象授权层 | 核对API连接的实际数据库/端口及视图所有者依赖权限；只补证据确认缺失的SELECT |

核心纪律：

> 先判断是哪一层，再处理该层。控制码错误不升级成部署问题，浏览器入口错误不升级成migration问题。

### 待办42501的已验证案例（2026-09-30）

候选 `0b748a82ea8e2972154b0a6ce4156d297c895857` 的原待办与合并列表报 `permission denied for view current_sourcing_case_lines`，数字生产待办、实时生产待办及计数查询成功。原 `TodoService` 通过 `current_sourcing_cases` 读取嵌套视图；不能因此改成另一套待办或重跑业务角色矩阵。

维护连接必须使用API实际连接的端口，并核对当前数据库、数据库OID以及两个视图OID。不要用默认端口连接一个同名数据库后就认为已授权成功。应用账号可以查询这些对象标识和 `current_setting('port')`；不要要求普通账号读取 `unix_socket_directories` 等受限设置。

默认视图按视图所有者检查底层关系的读取权限，因此只给运行角色 `dx_rework_acceptance_app` 授权可能不够。核对 `pg_class.relowner`、`reloptions`、`pg_rewrite/pg_depend` 以及 `has_table_privilege`；`security_invoker` 视图按实际调用账号检查，不盲目给所有者补权。

本次已确认 `current_sourcing_cases` 的所有者为 `dx_rework_acceptance`、`security_invoker=false`。嵌套视图读取通过后仍报底层表 `sourcing_style_revisions` 无权读取；按视图实际依赖补齐该所有者缺失的SELECT后，原列表、原计数、数字生产列表、实时生产列表、合并列表及合并计数全部PASS。浏览器“我的待办”模块切换、搜索和刷新也通过。维护只修改Acceptance库中证据确认缺失的SELECT，不改所有者、不授予全库权限、不涉及生产3201。

Acceptance以 `NODE_ENV=test` 启动时Fastify请求日志关闭，日志中没有 `request failed` 不代表接口未失败。必要时从当前已部署的dist调用原待办和各提供方，使用数据库只读连接逐段诊断；不要输出连接串或凭证。部分提供方可能包含写投影，遇到只读错误25006应记录为诊断边界，不能直接当成线上业务故障。

数据库诊断通过不等于业务流程全部通过。本次全部列表计数为0，只能证明读取恢复；仍须从页面验收真正产生的业务事项。

## 8. A1后的当前基线

A1首次canonical cutover已成功建立：

- Acceptance DB迁移至 `0221_digital_production_notifications`；
- Acceptance API由 `dxacceptance` PM2运行；
- 3202为新的canonical Acceptance API；
- Nginx Acceptance静态资源已指向 `/opt/dx-rework-acceptance/frontend/current`；
- 生产3201在切换后验证正常；
- 旧root Acceptance进程不再需要，后续不得恢复。

后续A2/A3/A4默认从这个状态增量更新，不再重复A1首次切换流程。

## 9. 每批验收结束的最小记录

```text
batch: A1/A2/A3/A4
candidate_sha: <40-char SHA>
schema: <version>
deployment_status: pass/fail
public_version_verified: yes/no
role_matrix: <pass>/<fail>/<pending>
business_scenarios: <summary>
production_3201: ready/not-ready
final_decision: accepted / fix-required
```

“部署通过”与“业务验收通过”必须分开记录。

## 9. Acceptance 隔离附件存储

Acceptance 启动通过既有独立数据库和 uat-root 校验后，自动使用
`/opt/dx-rework-acceptance/shared/attachments` 保存真实测试附件；首次上传由
`dxacceptance` 创建目录（0700），文件0600。目录位于release外，更新及重启保留附件。
不需要新增环境变量、OSS凭证或数据库migration；不允许接入生产OSS。
首次启用需将仓库shared-paths模板中的 `/acceptance/api/acceptance-files/` 专用location
补入现有Acceptance配置：请求上限21MiB（含multipart开销），关闭带短期授权的文件访问日志。
先执行 `nginx -t`，通过后reload；只增加Acceptance文件路径，不替换生产server块。
后续更新不重复此步骤。
生产仍使用原OSS实现。前端上传、业务权限、附件绑定、发布必填校验保持原路径。

上传授权只允许指定文件类型、大小和SHA256，最长5分钟；并发或重复上传不能覆盖。
下载仍先经过原业务权限校验获取短期地址。每文件上限20MiB，测试附件会占用ECS磁盘，
运维应计入验收磁盘使用量。此适配器用于附件业务验收，不代表OSS云端签名和图片处理验收通过；
缩略图请求返回原图，生产缩略图处理保持不变。不要单独清空目录，否则数据库附件引用会失效。

本次更新仅后端代码和文档变化，依赖及schema不变。按既有本机candidate更新路径构建API，
保留同SHA候选manifest一致性；无需重建环境、执行migration或配置真实OSS。
部署后在测试开发单上传PNG和PDF、保存重开、查看附件，再发布并继续岗位接力验收。


### 2026-11-01 工程治理：独立 Acceptance 与生产晋级

Acceptance 更新仍通过固定 root launcher、生产只读健康/锁、实际 Acceptance port/OID/角色/库名、owner 权限预检、必要备份和失败恢复，不接受手填数据库身份。源码检查使用 `--intent acceptance`；实际 Acceptance ledger 的未知 migration、checksum 漂移、历史缺口继续硬拒。生产 history 不再作为独立 Acceptance 更新的必要前置，不向 Acceptance worker 导出生产凭证或赋权。

实时 main 新增 migration 明确输出 `PENDING_RELEASE_INTEGRATION`，`productionPromotionVerified=false`、`applicationSemanticsVerified=false`。这不是生产上线通过。生产晋级/切换仍只允许准确 main SHA，须核真实 production ledger→candidate、声明支持源历史的真实升级/低权限/ACL/恢复及必要应用行为；禁止直接 release 部署 production。源码完整性不能证明 PMC 应用/API 已兼容；既有 PMC 部分403仍是独立上线待办，不为门禁抄 SQL 或扩大角色。

策略变更涉及已安装工具：仍遵守本手册原有显式同版本 `install` 后 `diagnose/update` 要求，不能靠 data-only refresh 偷换执行策略。本治理交付不执行任何现场 install/update/deploy。
