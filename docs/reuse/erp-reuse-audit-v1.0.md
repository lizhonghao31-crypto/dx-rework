# PR-00：ERP 只读复用审查 v1.0

> 状态：代码与公开运行态审查完成；ECS 内部稳定运行基线待补，PR-00 未完成  
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

本次只读取 ERP GitHub `main` 的稳定文件及无需身份、无需密钥的公开健康端点。未修改 ERP 仓库、ECS、Nginx、PM2、OSS、钉钉配置或生产数据；未调用业务读写 API，未读取或复制任何密钥和业务记录内容。

## 2. 结论先行

**ERP 值得复用的是已经验证过的流程、协议、部署骨架和防错机制，不是把现有代码整块复制过来。**

本结论分两个证据层级：身份、API、存储和公开健康端点的判断已由稳定代码与公开运行态支持；ECS 目录、Nginx、PM2、cron、logrotate、备份、发布和回滚目前只有代码/runbook 证据，尚未与 ECS 当前稳定版本共同核对，以下相关分类均为**候选分类**，不能作为 PR-00 已完成或 PR-01 已解锁的依据。

可以优先复用或抽取：

- React 19、Vite 8、Node 22 的版本方向；
- 钉钉容器免登与电脑扫码的双入口交互流程；
- 钉钉授权码在服务端换取用户身份的通信封装；
- ERP 代码/runbook 中的 `releases/current/shared/logs` 隔离思路和只读 Deploy Key；
- ERP 代码/runbook 中的 Nginx 反向代理、gzip、PM2、健康检查、冒烟检查、发布前备份和回滚思路；
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

运行态版本标签仍为旧阶段名，且 `/version` 未暴露 Git SHA，因此**不能证明 ECS 当前运行文件与最新 ERP `main` 完全一致**。本审查只把 GitHub 精确提交作为代码证据，把公开端点作为运行模式证据；它们尚不构成需求 v1.2 所要求的 GitHub `main` 与 ECS 当前稳定版本联合核验。

## 4. 复用矩阵

分类定义：

- **直接复用**：复用做法、脚本结构或非业务耦合实现，替换项目命名与路径后即可使用；
- **抽取复用**：保留成熟协议/算法，重写成独立模块并补测试；
- **重新实现**：现有实现不满足返工系统安全、并发、审计或未来 ERP 接入要求。
- **候选：直接复用/抽取复用**：代码或 runbook 已支持该方向，但 ECS 当前运行证据未补齐；只能作为设计假设，不能解除 PR-00 门禁。

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
| ECS 目录布局 | 代码/runbook 描述 `/opt/daxing-erp/releases/current/shared/logs` 与软链接回滚；未核当前 ECS | 候选：直接复用模式 | 使用独立 `/opt/dx-rework`；release 以 Git SHA 命名；不共享 ERP current、env、log、backup |
| GitHub 私库部署 | runbook 描述只读 Deploy Key；未核当前 ECS key 权限 | 候选：直接复用模式 | 新仓库使用独立只读 Deploy Key；禁止 write access；密钥只留 ECS |
| 环境变量 | runbook 描述 `/opt/daxing-erp/shared/.env` 权限 600；未核当前 ECS | 候选：直接复用模式 | 新系统独立 `.env`；启动时校验必需变量；日志和健康端点只返回是否配置，不返回值 |
| Nginx | 公开端点显示反代可用；完整 vhost 与当前加载配置未取证 | 候选：抽取复用 | 新域名或独立 location；先 `nginx -t`；不得覆盖 ERP vhost；配置应版本化且可回滚 |
| PM2 | 脚本包含独立服务名、restart/save、健康检查；未取得当前 PM2 dump | 候选：抽取复用 | 新进程名 `dx-rework-api`；独立 cwd/env/log；优雅关闭；不得 restart ERP 进程 |
| OSS 上传 | 服务端签名、白名单、大小限制、随机对象键；返回公开 URL | 抽取复用 | 独立 prefix；对象默认私有；数据库保存 objectKey/元数据；授权后签名读取；不信任扩展名或前端 actor |
| 应用日志 | PM2/cron 日志路径存在，但业务服务缺少统一结构化日志规范 | 重新实现 | JSON 日志、requestId、actorId、action、duration、result；脱敏；日志轮转与保留期配置 |
| 健康检查 | health/version/status 已验证 | 抽取复用 | 拆分 live/ready；`/version` 必须返回 Git SHA、构建时间和 schema version；依赖状态不泄密 |
| 数据备份 | 代码包含 JSON 写前备份、手动备份、cron、30天清理；未核实际任务与恢复记录 | 候选：抽取复用原则 | 改为关系数据库备份/PITR 或等价方案；附件不靠 DB 备份；执行恢复演练并记录 RPO/RTO |
| 发布脚本 | 代码包含 build、备份、Nginx/PM2、smoke、bundle hash 校验；未核线上实际发布链，且脚本存在硬编码旧路径 | 候选：抽取复用 | 精确 SHA 构建、immutable release、迁移前备份、原子软链切换、smoke、失败自动退回；禁止清空 ERP 目录 |
| 回滚 | runbook 描述 API 模式和 release 软链回退；未取得当前回滚/恢复记录 | 候选：直接复用思路 | 新系统只回滚自身服务；数据库迁移必须说明向前修复/可逆策略；不依赖 EMAS |
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

1. ERP `/version` 未返回 Git SHA，线上版本标签与当前阶段不一致；无法从端点证明部署的精确提交。
2. 当前完整 Nginx vhost、PM2 dump、cron 安装结果、logrotate 和备份恢复记录不在 GitHub `main` 中。
3. `scripts/deploy-ecs.sh` 写死既有 static release 目录，并直接清空该目录子项；只能借鉴检查顺序，不能复制到新系统。
4. `/api/staging/status` 的 OSS/钉钉 connected 字段是代码固定值，不是真实 readiness。

处理：这些差异阻塞 PR-00 完成，并按已确认路线图继续阻塞 PR-01 启动。取得 ECS 只读证据后，必须把当前稳定运行状态与 GitHub `main` 对照、记录差异，并重新确认部署相关复用分类；新系统从第一版就记录 Git SHA、独立路径和可恢复证据。

### 5.4 OSS 与附件差异（P1）

ERP 上传实现返回可公开访问 URL。返工 QC 图、扣款材料和责任证据属于内部资料，不能默认公开。

处理：复用服务端签名、白名单、大小限制和随机 key；新系统默认私有对象，通过授权 API 返回短时签名 URL，并把 objectKey、原文件名、MIME、大小、SHA-256、上传者和业务对象存数据库。

### 5.5 架构差异（P1）

ERP 的 raw Node router、巨型 `App.jsx` 和共享根文档是历史演进结果。返工系统需要未来被 ERP 节点调用，因此必须把领域、应用服务、基础设施和 ERP adapter 分开，不能让接口依赖页面状态。

## 6. PR-01 技术基座候选输入

本节可用于提前评审技术方向，但在第 8.1 节 ECS 证据门禁关闭前，不授权启动 PR-01 施工。

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

### 8.1 PR-00 必须补齐的 ECS 只读证据包

以下证据仅需配置和文件元数据，不得包含密钥、环境变量值、业务数据或个人信息：

| 证据 | 最低内容 | 用途 |
|---|---|---|
| 当前发布身份 | `current` 实际路径、发布目录名、部署 Git SHA 或等价 release manifest | 将运行态绑定到精确版本；若无法绑定，记录为差异 |
| Nginx | ERP 相关的已加载 server/location 片段，域名、upstream、静态目录和 gzip；敏感值脱敏 | 核对真实 vhost、端口、路径与隔离边界 |
| PM2 | ERP 进程名、状态、cwd、script、Node 版本、日志路径；不含 env 值 | 核对进程模型和发布脚本假设 |
| cron/logrotate | ERP 相关定时任务与日志轮转规则、最近执行状态 | 核对备份和日志保留是否真实启用 |
| 备份 | 最近备份文件名/时间/大小、保留期和失败记录；不提供文件内容 | 判断备份链是否可复用 |
| 恢复/回滚 | 最近一次恢复或回滚演练记录；若从未演练，明确记为“无证据” | 避免把 runbook 当成已验证能力 |

验收动作：将上述事实与 ERP `main@2adc6be2b9d7ca59704b28a2b2c89cea1c2e1853` 逐项对照，记录一致、偏差和废弃配置，随后把矩阵中的“候选”改为最终分类并重新触发 Codex Review。该证据包未完成前，PR-00 保持未完成，PR #4 不合并，PR-01 不启动。

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

**PR-00 已完成代码与公开运行态审查，但尚未达到合并完整度，也不足以解除 PR-01 前置门禁。**

优势：ERP 的双端钉钉流程、OSS/健康检查和发布防错经验已有稳定代码证据；公开端点补充确认了 Node 22 和 native 路由运行模式，可以显著减少应用层试错。

主要风险：如果把“复用”误解为复制当前鉴权或 JSON 存储，新系统会把客户端伪造身份、组织准入不足、并发与审计风险一起继承。

置信度：

- GitHub 稳定代码审查：高（约 0.92）；
- 公网运行模式核验：中高（约 0.82）；
- ECS 内部 Nginx/PM2/cron/logrotate 与实际部署 SHA：中低（约 0.55，因无 ECS shell 只读快照）。

最终决定：

1. PR #4 保持打开，PR-00 状态保持“部分完成”；
2. 在取得第 8.1 节 ECS 只读证据、处理代码与运行态差异并通过复核前，不合并 PR #4、不启动 PR-01；
3. 证据补齐后再定稿 ECS/Nginx/PM2/备份/发布/回滚的复用分类；
4. 后续 PR-01 仍采用独立关系数据库、模块化服务和可信服务端身份；PR-02/PR-03 分别承接钉钉准入和 OSS/Tools 抽取；
5. 未经新的书面变更，不修改 ERP，也不把新系统部署到 ERP 的进程、目录或数据中。
