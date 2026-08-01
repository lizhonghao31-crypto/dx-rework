# PR-00：ERP 只读复用审查 v1.0

> 状态：代码、公开运行态与 ECS 内部稳定基线联合审查完成；待最终复核与 PR 合并  
> 审查日期：2026-08-01  
> 新系统仓库：`lizhonghao31-crypto/dx-rework`  
> 新系统基线：`main@b5ec95e56e6afe30a219151caeae3c4587c4e23c`  
> ERP 审查仓库：`lizhonghao31-crypto/daxing-erp-scm`  
> ERP 代码基线：`main@2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853`  
> 需求基线：`docs/requirements/startup-requirements-v1.2.md`

## 1. 审查目的与只读边界

本审查用于回答三个问题：

1. ERP 哪些成熟能力可以直接复用或抽取，避免重复造轮子；
2. 哪些实现只适合 ERP 当前历史架构，复制到返工系统会造成安全、维护或未来接入风险；
3. PR-01 独立技术基座应按什么边界施工，才能独立运行且后续可接入 ERP “质检返工”节点。

本次读取 ERP GitHub `main` 的稳定文件、无需身份或密钥的公开健康端点，以及由业务负责人在 ERP ECS Workbench 中执行的脱敏只读命令结果。未修改 ERP 仓库、ECS、Nginx、PM2、OSS、钉钉配置或生产数据；未调用业务读写 API，未读取或复制密钥、环境变量值和业务记录内容。

## 2. 结论先行

**ERP 值得复用的是已经验证过的流程、协议、部署骨架和防错机制，不是把现有代码整块复制过来。**

本结论已联合核对 GitHub 稳定代码、公开运行态和 ECS 当前稳定版本。联合核验不是证明线上与 `main` 完全一致，而是明确找出了二者的实际差异：ECS 部署提交落后 `main` 67 个提交、release 目录名称不能追溯内部 Git SHA、正式站 Nginx 写死旧前端目录、未发现专用 logrotate 或恢复演练证据。因此部署相关结论已从“候选”定稿为“抽取复用”或“重新实现”，不能整套复制。

可以优先复用或抽取：

- React 19、Vite 8、Node 22 的版本方向；
- 钉钉容器免登与电脑扫码的双入口交互流程；
- 钉钉授权码在服务端换取用户身份的通信封装；
- `current` 软链接、独立进程名、Nginx 反向代理、gzip、健康检查和定时备份的结构思路；
- 服务隔离、冒烟检查、发布前备份和失败回退的检查顺序；
- OSS 密钥只在服务端、文件类型/大小校验、对象键随机化等上传机制；
- 乐观版本冲突、幂等保护、追加式审计日志等数据安全经验。

必须重新实现：

- 公司组织成员与在职/启用状态强校验；
- `DingTalk userId/unionId → internal userId → role → capability` 的身份和权限链；
- 服务端会话、后端授权和 CSRF 防护；
- 关系数据库、事务、迁移、并发上数和金额一致性；
- 私有附件访问、审计事件、outbox 和未来 ERP 适配层；
- 新系统独立的 Nginx、PM2、日志、备份、发布和回滚配置。

明确禁止复制：

- 通行码/密码正式登录；
- `localStorage` 保存可伪造的完整身份会话；
- 前端携带共享 API 暗号；
- 客户端自行上报 `operator.role/userid` 后由服务端直接相信；
- 姓名回退角色映射或可选白名单代替组织校验；
- ERP 巨型单文件和单 JSON 根文档存储；
- 默认公开 OSS URL；
- 写死旧分支、旧 release 目录或 ERP 路径的发布脚本。

## 3. 证据基线

### 3.1 稳定代码证据

以下证据全部固定到 ERP 提交 `2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853`：

| 证据 | 说明 |
|---|---|
| [`package.json`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/package.json) | Node 22、npm 10、React 19、Vite 8 基线 |
| [`server/dingtalk-login.cjs`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/server/dingtalk-login.cjs) | 扫码和容器换码、userid/name 映射与当前准入逻辑 |
| [`functions/index.js`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/functions/index.js) | 历史扫码链中 `unionId → 公司 userid` 的实现经验 |
| [`src/auth/LoginShell.jsx`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/src/auth/LoginShell.jsx) | 钉钉容器免登、DTFrameLogin 扫码、重复 code 锁；同时存在通行码和本地会话风险 |
| [`server/native-erp-api.cjs`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/server/native-erp-api.cjs) | 版本冲突、审计、OSS 路由及当前共享暗号/客户端 operator 风险 |
| [`server/oss-media.cjs`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/server/oss-media.cjs) | 后端签名 PUT、文件白名单、大小限制和随机对象键 |
| [`server/ecs-healthz.cjs`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/server/ecs-healthz.cjs) | health/version/status、API 路由与服务端环境加载 |
| [`scripts/deploy-ecs.sh`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/scripts/deploy-ecs.sh) | 构建、备份、Nginx/PM2、smoke、静态包校验发布链 |
| [`scripts/ecs-smoke-check.sh`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/scripts/ecs-smoke-check.sh) | 页面、路由、store、API、gzip、上传路由冒烟检查 |
| [`scripts/ecs-install-native-backup-cron.sh`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/scripts/ecs-install-native-backup-cron.sh) | 定时备份、日志与保留期骨架 |
| [`docs/ecs-private-repo-deploy-runbook-v1.md`](https://github.com/lizhonghao31-crypto/daxing-erp-scm/blob/2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853/docs/ecs-private-repo-deploy-runbook-v1.md) | 只读 Deploy Key、immutable release、current 软链接和回滚模式 |
| [ERP PR #41](https://github.com/lizhonghao31-crypto/daxing-erp-scm/pull/41) | ECS native、OSS、钉钉、备份与运维成果进入 `main` 的来源记录 |

### 3.2 运行态只读核验

2026-08-01 13:23（Asia/Taipei）无密钥访问公开端点得到：

| 端点 | 观察结果 | 结论 |
|---|---|---|
| [`/healthz`](https://staging-api.dxerp.org.cn/healthz) | 服务在线，`erpApiMode=native` | ECS Node 入口在线 |
| [`/version`](https://staging-api.dxerp.org.cn/version) | Node `v22.22.2`，但未返回 Git SHA | Node 22 已验证；发布不可追溯到精确提交 |
| [`/api/staging/route-status`](https://staging-api.dxerp.org.cn/api/staging/route-status) | `route=ecs-native-json` | 当前业务路由为 native |
| [`/api/staging/native-status`](https://staging-api.dxerp.org.cn/api/staging/native-status) | native store 存在且可解析 | 只确认存储健康，不读取业务内容 |
| [`/api/staging/status`](https://staging-api.dxerp.org.cn/api/staging/status) | 关系数据库未配置，EMAS proxy 回滚路径 ready；OSS/钉钉连接字段为 false | ERP 仍以 JSON store 为主；该页的 OSS/钉钉字段在代码中为固定占位，不能当成真实连通性证据 |

运行态版本标签仍为旧阶段名，且 `/version` 未暴露 Git SHA，因此仅靠公开端点**不能证明 ECS 当前运行文件与最新 ERP `main` 完全一致**。第 3.3 节通过 ECS 只读命令补齐了精确部署提交、Nginx、PM2、cron、备份与恢复证据，并据此完成联合核验。

### 3.3 ECS 内部稳定基线只读核验

2026-08-01 由业务负责人在 ERP ECS Workbench 中执行脱敏只读命令，未读取 `.env`、密钥或业务文件内容。结果如下：

| 项目 | ECS 当前事实 | 联合核验结论 |
|---|---|---|
| 后端 current 与 Git SHA | `/opt/daxing-erp/current` 指向 `/opt/daxing-erp/releases/phase4b-debug-20260430174100`；内部 Git SHA 为 `5c8c62cb92f69c188df4b3af1ba4f0fe0836e3f7` | 运行提交可被精确识别，但 release 名称与内部提交时间/身份不一致，不能视为不可变 release |
| GitHub 差异 | 部署 SHA 是 `main@2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853` 的祖先；GitHub compare 显示 `main` 领先 67 个提交 | ECS 当前稳定版本不等于最新 `main`；代码复用必须以 `main` 为设计证据，以 ECS 为运行差异证据 |
| PM2 | `daxing-healthz` 与 `manual-scheduling-solver` 从 ERP release 运行；`daxing-sample-api` 从独立 `/opt/daxing-sample` 运行；三者在线 | 独立进程名和 cwd 隔离有效；ERP 与样衣系统仍共用一台 ECS，返工系统必须使用独立目录、进程、端口和日志 |
| 运行时 | ERP health 服务使用 Node；manual scheduling solver 使用系统 Python 3.6 | 新系统只采用锁定的 Node 22 基座，不复制 Python 3.6 运行链 |
| Nginx | `staging-api.dxerp.org.cn` 同时承载 ERP `127.0.0.1:3000`、样衣 API `127.0.0.1:3107` 及两套前端路径；gzip 已启用 | 反代和 gzip 可抽取；新系统不得继续塞入同一 vhost，必须使用独立域名或清晰隔离的 location |
| 正式站静态目录 | `dxerp.org.cn` 仍写死 `/opt/daxing-erp/frontend/releases/phase4a-frontend-fix-20260430151038/official` | 不能复制硬编码 release 路径；新系统必须使用 SHA release、原子软链接与可验证回滚 |
| cron 与备份 | 每日 02:30 运行 native backup，02:45 按 30 天保留期清理；2026-07-30、07-31、08-01 日志均返回成功 | 定时备份机制实际在运行，可抽取调度与结果日志模式 |
| 备份路径 | 自动任务的成功日志把文件写入 `data/manual-backups`，而 `data/backups` 未列出自动备份文件 | 目录命名与实际写入不一致，不能直接复用路径或清理假设 |
| logrotate | 未发现文件名包含 `daxing`、`erp` 或 `backup` 的专用 `/etc/logrotate.d` 配置 | 不能把日志轮转视为已验证能力；新系统必须自行实现和验收 |
| 恢复/回滚 | 未发现真正的 restore/rollback 演练日志；搜索命中的两个 `drilldown` 文档属于业务分析模板 | 备份成功不等于可恢复；恢复演练继续作为 PR-17 上线硬门槛 |

ECS 登录横幅还显示存在待处理的安全更新。本审查未执行系统升级；在新系统首次 staging 部署前，基础设施负责人应先评估补丁、安排维护窗口并完成回归，避免在未验证情况下直接升级共用服务器。

## 4. 复用矩阵

分类定义：

- **直接复用**：复用做法、脚本结构或非业务耦合实现，替换项目命名与路径后即可使用；
- **抽取复用**：保留成熟协议/算法，重写成独立模块并补测试；
- **重新实现**：现有实现不满足返工系统安全、并发、审计或未来 ERP 接入要求。

| 能力 | ERP 当前事实 | 决策 | 新系统落地要求 |
|---|---|---|---|
| 钉钉移动端免登 | 前端 `requestAuthCode`，服务端以一次性 code 换用户 | 抽取复用 | 保留双端流程和防重复 code；后端建立会话，前端不保存可伪造角色 |
| 电脑端扫码 | `DTFrameLogin` + OAuth code；历史链包含 `unionId → 公司 userid` | 抽取复用 | 以钉钉当前官方接口重新验证；扫码身份必须解析为本公司 userid 后才进入系统 |
| 公司组织成员校验 | 当前 helper 的 `allowedUserids` 可为空，且支持姓名回退；不满足强组织门禁 | 重新实现 | 服务端校验指定 corp、当前有效成员/在职状态；失败即拒绝；无角色只显示未开通 |
| 人员与角色绑定 | 当前存在 userid 配置和姓名映射 | 重新实现 | 稳定 DingTalk ID 映射内部 user ID；角色、capability、数据范围存数据库并可审计；禁止姓名路由 |
| 登录会话 | 当前前端写 `localStorage`，服务端没有与用户绑定的可信会话 | 重新实现 | Secure、HttpOnly、SameSite cookie；服务端 session；过期、撤销、离职即时失效；CSRF 防护 |
| API 鉴权 | 当前共享暗号可由前端携带，且接受客户端传来的 operator/role | 重新实现 | 每次请求从服务端 session 取 actor；后端 capability 校验；拒绝客户端指定角色或审批人 |
| 乐观锁与防重复 | 订单 `version`、`baseVersion` 冲突；部分审计动作去重 | 抽取复用 | 数据库行版本、幂等键和唯一约束；上数并发在事务内原子校验剩余量 |
| 审计日志 | 追加记录 operator、动作、对象、前后值；当前 actor 仍来自客户端 | 抽取复用 | actor 来自可信 session；使用稳定 event ID，保存前后状态、原因、关联审批/代理和 request ID |
| ECS 目录布局 | current 软链接存在，但 `phase4b-debug-20260430...` 目录内部为 2026-07 部署提交，名称不能追溯 SHA | 抽取复用 | 使用独立 `/opt/dx-rework`；release 必须以 Git SHA 命名且不可原地更新；不共享 ERP current、env、log、backup |
| GitHub 私库部署 | runbook 给出只读 Deploy Key；本次按安全边界不读取 ECS 密钥或权限 | 抽取复用原则 | 新仓库使用独立只读 Deploy Key；禁止 write access；密钥只留 ECS；首次部署时验证权限 |
| 环境变量 | runbook 给出 shared `.env` 与权限要求；本次未读取环境变量值 | 抽取复用原则 | 新系统独立 `.env`；启动时校验必需变量；日志和健康端点只返回是否配置，不返回值 |
| Nginx | 已加载配置验证反代、gzip 和 TLS；同一 staging vhost 混合 ERP/样衣路由，正式站写死旧 release | 抽取复用 | 新域名或清晰隔离的独立 location；先 `nginx -t`；不得覆盖 ERP vhost；配置版本化且可回滚 |
| PM2 | 三个进程在线，ERP 与样衣有独立名称/cwd，但共用服务器；ERP release 内还运行 Python 3.6 solver | 抽取复用 | 新进程名 `dx-rework-api`；独立 cwd/env/log/端口；仅用锁定 Node 22；不得 restart ERP 或样衣进程 |
| OSS 上传 | 服务端签名、白名单、大小限制、随机对象键；返回公开 URL | 抽取复用 | 独立 prefix；对象默认私有；数据库保存 objectKey/元数据；授权后签名读取；不信任扩展名或前端 actor |
| 应用日志 | 备份日志存在，但未发现 ERP 专用 logrotate；业务服务缺少统一结构化日志规范 | 重新实现 | JSON 日志、requestId、actorId、action、duration、result；脱敏；独立 logrotate 与保留期配置并验收 |
| 健康检查 | health/version/status 已验证 | 抽取复用 | 拆分 live/ready；`/version` 必须返回 Git SHA、构建时间和 schema version；依赖状态不泄密 |
| 数据备份 | cron 与近三日成功日志已验证，保留期 30 天；实际写入 `manual-backups`，无恢复演练 | 抽取复用原则 | 改为关系数据库备份/PITR 或等价方案；路径与清理规则一致；附件独立；执行恢复演练并记录 RPO/RTO |
| 发布脚本 | 代码有 build、备份、smoke、bundle hash；运行态 release 名称与内部 SHA 不一致，Nginx 仍写死旧目录 | 抽取复用检查顺序 | 重新编写新系统发布脚本：精确 SHA、immutable release、迁移前备份、原子软链、smoke、失败自动退回；禁止清空 ERP 目录 |
| 回滚 | 只有 runbook/脚本思路，未找到真实恢复或回滚演练记录 | 重新实现并验证 | 新系统只回滚自身服务；数据库迁移说明向前修复/可逆策略；上线前完成可重复恢复演练，不依赖 EMAS |
| 数据存储 | ECS native 单 JSON 根文档，关系数据库未配置 | 重新实现 | 使用关系数据库和迁移；金额、审批、工资、扣款、审计、outbox 分表并保持事务一致性 |
| CI/GitHub 治理 | 精确 Head、build 与小 PR 经验成熟 | 直接复用模式 | 保留 SHA 证据；增加 lint、unit、integration、迁移检查、权限拒绝测试和 secret scan |

## 5. 差异、矛盾与风险清单

### 5.1 身份与权限差异（P0）

1. ERP 当前支持正式页面通行码/本地调试码，新系统需求明确禁止该入口。
2. ERP 前端把完整身份写入 `localStorage`；服务端又接受客户端自报 operator/role，无法作为新系统审批和工资授权的信任基础。
3. ERP 当前 `DING_ALLOWED_USERIDS` 为空时不执行白名单门禁，并可按姓名推断角色；不等同于“必须属于公司组织且当前有效”。
4. ERP 当前扫码 helper 未完整保留历史实现中的 `unionId → 本公司 userid` 组织解析步骤；新系统必须把它作为组织准入核心，而不是复制当前简化 helper。

处理：PR-02 只复用钉钉交互和换码协议，组织准入、内部用户、session 和 capability 全部按新边界实现。

### 5.2 数据与并发差异（P0）

ERP 当前运行态仍为单 JSON store。它不适合作为返工系统的工资、金额、多人并发上数、审批、扣款和月结锁定底座，也无法满足未来 ERP 双向幂等接入的事务要求。

处理：PR-01 默认采用 PostgreSQL 关系数据库；如果公司已有统一受管 MySQL 8，可在创建首个 migration 前通过 ADR 切换，但不得退回 JSON 根文档或前端本地数据库作为 Golden Source。

### 5.3 部署证据差异（P1）

1. ERP `/version` 未返回 Git SHA；ECS shell 虽确认部署 SHA，但它比 GitHub `main` 落后 67 个提交。
2. release 目录名称为 2026-04 阶段名，内部 Git SHA 对应 2026-07 提交，不能满足不可变、可追溯发布要求。
3. staging Nginx 混合 ERP 与样衣路由，正式站仍写死旧前端 release；不能复制现状。
4. 自动备份近三日成功，但输出落在 `manual-backups` 而非 `backups`，且没有恢复演练证据。
5. 未发现 ERP 专用 logrotate；`/api/staging/status` 的 OSS/钉钉 connected 字段又是固定占位，不能作为 readiness。
6. ECS 登录横幅显示待处理安全更新；共用服务器升级必须先评估、备份和回归，不能在本项目中顺手执行。

处理：PR-00 已通过只读证据把差异显式化并定稿复用边界。上述问题不阻塞 PR-01 的本地技术基座，但全部转化为 PR-01/PR-17 的明确约束；在首次 staging 部署前不得复用旧路径、旧 vhost、旧进程或未经验证的恢复方案。

### 5.4 OSS 与附件差异（P1）

ERP 上传实现返回可公开访问 URL。返工 QC 图、扣款材料和责任证据属于内部资料，不能默认公开。

处理：复用服务端签名、白名单、大小限制和随机 key；新系统默认私有对象，通过授权 API 返回短时签名 URL，并把 objectKey、原文件名、MIME、大小、SHA-256、上传者和业务对象存数据库。

### 5.5 架构差异（P1）

ERP 的 raw Node router、巨型 `App.jsx` 和共享根文档是历史演进结果。返工系统需要未来被 ERP 节点调用，因此必须把领域、应用服务、基础设施和 ERP adapter 分开，不能让接口依赖页面状态。

## 6. PR-01 技术基座输入

本节已完成代码与运行态联合核验，可在 PR #4 最终复核并合并后作为 PR-01 的正式施工输入。

### 6.1 推荐工程结构

```text
apps/
  web/                 React 19 + Vite 8 + TypeScript
  api/                 Node 22 + TypeScript + 模块化 HTTP 服务
packages/
  domain/              返工、上数、工资、责任、扣款领域规则
  contracts/           API、事件、ERP 适配契约与校验 schema
  ui/                  从已通过 Figma 落地的 token 与通用组件
  config/              类型化配置和环境校验
infra/
  nginx/               新系统独立配置模板
  pm2/                 不含 secret 的进程配置
scripts/               deploy、smoke、backup、restore-check、rollback
docs/adr/               数据库、身份、附件和集成决策记录
```

后端不得继续采用一个巨型 action router。至少拆分：identity、authorization、rework-case、operation/pricing、assignment/piecework、responsibility、payroll、deduction、attachment、notification、audit、ERP adapter。

### 6.2 必须在 PR-01 建立的能力

1. Node 22、npm 10 锁定文件和可复现安装；
2. Web/API 独立构建与本地开发入口；
3. PostgreSQL 默认配置、版本化 migration、测试数据库；
4. 配置分层与启动时校验，仓库只保存变量名；
5. `/health/live`、`/health/ready`、`/version`，其中 `/version` 返回 Git SHA；
6. 统一错误格式、requestId、结构化日志和敏感信息过滤；
7. 数据库事务、审计表、outbox 表、idempotency key 与 version 字段骨架；
8. ERP adapter 空实现和来源字段，不进行真实 ERP 读写；
9. CI：lint、typecheck、unit、integration、build、migration check、secret scan 和精确 Head SHA；
10. 独立 ECS 路径、服务名、日志和备份约定文档；本 PR 不实际部署。

### 6.3 PR-01 明确不做

- 不实现真实钉钉登录，只建立 identity/session 接口边界；
- 不实现返工业务页面或业务节点；
- 不读取或回写 ERP；
- 不创建生产数据库或修改 ECS；
- 不复制 ERP 通行码、共享暗号、角色表、JSON store、巨型 action router；
- 不将 Figma 全部页面一次性写成业务代码，UI 代码在技术基座后按 PR-01A 设计逐步落地。

### 6.4 PR-01 合并门槛

- 新环境从零安装、migration、test、build 全部通过；
- 任一 API 返回可追踪 requestId，`/version` 可反查当前 Git SHA；
- 配置缺失时 fail fast 且不泄露值；
- 数据库事务、version 冲突、idempotency 与 audit/outbox 骨架有自动化测试；
- ERP 不运行时新系统 health/live 仍正常；
- 新系统任何进程、路径、端口、日志和数据都不与 ERP 共用；
- GitHub Actions 证据对应 PR 当前 Head SHA。

## 7. 后续 PR 的复用约束

| 路线 | 本审查输入 |
|---|---|
| PR-02 钉钉准入 | 复用双入口和 code 换身份流程；重建组织校验、session、内部用户和 capability |
| PR-03 公共 Tools | 抽取 OSS、幂等、统一错误、审计/outbox；附件改为私有访问 |
| PR-04 权限资料 | 稳定 userId 绑定，禁止姓名判断；李总/李生与李同生严格隔离 |
| PR-07 上数 | 关系数据库事务、原子余量校验、幂等键、成员快照版本 |
| PR-13 钉钉消息 | 使用 outbox 和幂等发送；不得与业务事务形成部分成功 |
| PR-16 ERP 契约 | 只通过 adapter、稳定 ID、版本化合同和幂等键接入 |
| PR-17 部署 | 使用 PR-00 经运行态核验后的 ECS 安全步骤，并完成新系统自己的 Nginx/PM2/cron/logrotate/restore drill 验收 |

## 8. 尚待补齐的信息及阻塞时点

### 8.1 PR-00 ECS 只读证据包完成状态

| 证据 | 状态 | 结论去向 |
|---|---|---|
| 当前发布身份与 Git SHA | 已完成 | 第 3.3、4、5.3 节；确认部署落后 `main` 67 个提交且 release 不可按名称追溯 |
| Nginx 已加载配置 | 已完成 | 第 3.3、4、5.3 节；抽取反代/gzip，拒绝混合 vhost 与硬编码旧目录 |
| PM2 进程/cwd/runtime | 已完成 | 第 3.3、4 节；抽取独立进程模式，拒绝共享目录和 Python 3.6 链 |
| cron、日志与保留期 | 已完成 | 第 3.3、4 节；备份调度可抽取，logrotate 重新实现 |
| 最近备份结果 | 已完成 | 第 3.3、4、5.3 节；近三日成功但路径语义不一致 |
| 恢复/回滚演练 | 已完成核查，结果为无证据 | 不虚构“已验证回滚”；转为 PR-17 上线硬门槛 |

证据包未包含密钥、环境变量值或业务记录内容。PR-00 的核验目标已经完成；“无恢复演练”是明确审查结论，不再作为无限期阻塞开发的缺失信息，但必须阻塞 PR-17 上线。

### 8.2 后续阶段信息

以下信息不阻塞 PR-00 代码审查，但必须在对应阶段前补齐：

| 信息 | 最迟时点 | 影响 |
|---|---|---|
| 新系统钉钉应用/corp 配置及真实稳定 userId | PR-02 联调前 | 组织准入与实名角色绑定 |
| 新系统独立域名或 URL path | 首次 staging 部署前 | 扫码回调、Nginx、Cookie scope |
| PostgreSQL 可用方式（受管实例或 ECS 独立实例） | PR-01 首个 migration 合并前 | 数据库连接、备份与恢复方案 |
| OSS bucket/prefix、私有读策略和生命周期 | PR-03 联调前 | QC/扣款附件安全 |
| 一次数据库恢复演练及 RPO/RTO 记录 | PR-17 上线前 | 可恢复性验收 |

## 9. 审查判断

**PR-00 已完成 GitHub 稳定代码、公开运行态与 ECS 当前稳定版本的联合核验，达到最终技术复核和合并完整度。**

优势：ERP 的双端钉钉流程、OSS/健康检查、Nginx/PM2 隔离方式和定时备份已有代码或运行证据，可减少应用层和基础运维试错。

主要风险：如果把“复用”误解为复制当前鉴权、JSON 存储或 ECS 现状，新系统会继承客户端伪造身份、组织准入不足、并发审计、版本不可追溯、混合 vhost、无恢复演练等风险。

置信度：

- GitHub 稳定代码审查：高；依据是所有代码结论均固定到精确 SHA。
- 公网运行模式核验：中；公开端点能证明服务模式，但不能独立证明部署 SHA。
- ECS 内部运行基线：高；依据是 root Workbench 的只读命令直接返回 current、Git SHA、PM2、Nginx、cron 与备份结果。
- 恢复能力：低；原因是只确认备份成功，未发现恢复或回滚演练记录。

最终决定：

1. PR #4 进入最终 Codex Review；复核通过并合并后启动 PR-01；
2. PR-01 采用独立关系数据库、模块化服务、可信服务端身份、独立进程/路径/日志，并从第一版返回 Git SHA；
3. PR-02/PR-03 分别承接钉钉准入和 OSS/Tools 抽取；
4. PR-17 必须完成新系统真实数据库恢复、应用回滚、logrotate、补丁评估和 RPO/RTO 验收；
5. 未经新的书面变更，不修改 ERP，也不把新系统部署到 ERP 的进程、目录或数据中。
