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

### 固定更新命令（2026-10-03）

业务负责人要求固定为 `dx-acceptance update`，替代每批生成和修改 `/tmp/update-acceptance-*.sh`。首次由 root 从已合并的集成分支安装 `scripts/dx-acceptance.sh` 到 `/usr/local/bin/dx-acceptance`；后续只执行：

```bash
dx-acceptance update
```

默认取 `release/digital-production-v1` 最新已合并 SHA；需要固定已核准候选时使用 `dx-acceptance update <40位SHA>`，该 SHA 必须在集成分支历史中。仍须遵守候选合并前 Gate/Review 纪律。

命令复用生产源码仓库的既有 Git 认证，只 fetch/archive，不 checkout 或构建生产源码。先以生产运行用户只读导出迁移历史，不向 Acceptance worker 传入生产连接凭据；以 `dxacceptance` 构建候选，并按实际 diff 决定前端重建或复用。仅 lockfile 相同且依赖检查通过时复制现有依赖，缺失或不一致则在候选中 `npm ci`；所有 workspace 链接修正到候选目录。

更新器核验两个现场迁移历史、Acceptance 运行参数及实际数据库名。在停止 Acceptance 后，存在 pending migration 才备份。数据库维护复用本机 postgres 认证入口和运行连接的实际端口，核验数据库 OID、名称及所有者后，将会话身份降为固定所有者 `dx_rework_acceptance` 执行迁移；运行账号不需要 DDL 权限。备份 SHA256 和清单已验证，且同候选、同数据库、同迁移历史、服务持续停止时才可复用失败重试的备份；服务启动后撤销这一复用资格。迁移部分失败时保持 Acceptance 停止，不自动切回不兼容旧代码，再执行同一固定命令可继续向前迁移。

候选直接安装到既有 generation 目录，更新指针及 `dx-rework-acceptance-api`。技术验证覆盖本机/公网 ready、精确 SHA/schema、公网 HTML 与静态资源内容、生产 3201 ready。已是同 SHA 且 schema current 时仅验证，不重复备份或重启。证据位于 `logs/update-<SHA>-<时间>-<PID>`。常规更新不修改 Nginx、角色/HBA/密钥或生产服务；附件 location 沿用已完成的 606 配置。

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

- 当前批次存在migration时，部署前做一次Acceptance数据库备份；同一候选重试且数据库未发生新业务写入时不重复备份。
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
