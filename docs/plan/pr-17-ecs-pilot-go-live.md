# PR-17：ECS 部署、全链路验收与试点上线（冻结施工契约）

> 路线 ID：`PR-17`  
> Repository：`lizhonghao31-crypto/dx-rework`  
> 原 A 阶段 Base：`main@918026f77d20046b3a28aac8c33c9b85ebda5282`  
> 当前 B 阶段候选基线：以 GitHub 最新 `main` Exact SHA 为准；2026-08-07 已核验基线为 `7c48902c6506e529f67f480f784d18c11f4a382c`  
> 2026-08-07 部署决策更新：Pilot/验收复用 `https://staging-api.dxerp.org.cn/rework/`，采用显式 `shared_path` 模式；不因共享 HTTPS origin 而共享应用运行时。

## 1. 唯一目标

把仓库现有 Nginx、PM2、PostgreSQL 备份、健康检查与发布安全机制封闭为一套可审查、可重复、可追溯、可恢复和可回滚的返工系统上线体系，并完成正式上线前的 22 项业务验收、达兴广州尾部小范围试点与证据留存。

PR-17 不开发新的业务模块，不改写已确认的审批、权限、工资、责任、扣款或 ERP 契约事实。

## 2. 分阶段边界

### A. 代码与运维闭环

完成部署脚本、配置模板、受控工作流、备份恢复、回滚、冒烟、验收矩阵与运行手册。A 阶段代码已进入主干；后续修复只允许针对现场发现的确定部署缺陷增量前向修正。

### B. 隔离运行时部署验证

运行时隔离定义为：独立 `/opt/dx-rework`、PM2 `dx-rework-api`、本机端口 `127.0.0.1:3201`、独立 PostgreSQL 数据库/迁移、日志、备份、release/generation、配置与证据目录。

当前 Pilot 入口确认采用：

```text
HTTPS origin: https://staging-api.dxerp.org.cn
Web namespace: /rework/
API namespace: /rework/api/
Nginx mode: shared_path
```

共享 origin 只复用现有 dxerp 系 TLS/证书与入口层，不允许返工系统接管共享域名根 `/`、根级 `/health/*`、`/version`、其他 `/api/*`、ERP 或样衣路径。Nginx 配置变更只能在单独基础设施窗口执行，routine release 不 reload Nginx。

B 阶段先完成只读 preflight，再执行精确 SHA bundle、备份、必要前向 migration、原子 activation、外部 `/rework/` smoke、隔离恢复和回滚演练。

### C. 达兴广州尾部试点

先选择少量工序和 2 名工人，使用脱敏或明确授权的真实业务资料完成 22 项场景及角色验收。试点前必须关闭 S-04。

### D. 正式上线

必须同时具备：代码门禁全绿、精确 main SHA 部署证据、22 项验收通过、隔离恢复成功、回滚成功、日志轮转生效、培训完成、试点签字和上线窗口批准。

任一阶段未满足门槛，不得进入下一阶段。

## 3. 允许施工范围

可新增或增量修改：

- `.github/workflows/` 下 PR-17 专用手动发布与验证工作流；
- `scripts/deploy/`、`scripts/acceptance/`、PostgreSQL 备份与隔离恢复脚本；
- `infra/nginx/`、`infra/pm2/`、`infra/logrotate/` 的返工隔离配置/共享路径片段；
- `.env.example`、`package.json` 中与部署验证直接相关的变量名和命令；
- `docs/operations/`、本施工契约及路线图；
- 对应 unit/integration/structure tests。

只有现有 `/health/live`、`/health/ready`、`/version` 无法支撑精确部署核验时，才允许对技术诊断接口做最小增量修改。不得借机修改业务服务、业务状态机、金额算法、业务 UI 或历史 migration。

## 4. 必须交付

### 4.1 精确 Head 与不可变 Release

1. Release 目录固定为 `/opt/dx-rework/releases/<40位git-sha>`；前端为 `/opt/dx-rework/frontend/releases/<40位git-sha>`。
2. 构建产物生成 manifest，至少记录 Git SHA、构建时间、Node/npm 版本、数据库 schema version、文件 checksum。
3. 手动发布只接受当前精确 `main` SHA；release 目录、manifest、运行中 `/version.gitSha` 必须完全一致。
4. 禁止阶段名、时间戳或 `latest` 代替 Git SHA；禁止原地覆盖 release。
5. API/frontend 使用同一 `active` generation 原子切换；`current` 稳定别名不得分别漂移。

### 4.2 Fail-closed 部署预检

通用预检至少验证：

- Linux、Node 22、npm 10、PostgreSQL 客户端、Nginx、PM2、磁盘、内存和端口；
- `/opt/dx-rework` 全部目录边界、属主、权限、非软链接父路径；
- `/opt/daxing-erp`、`/opt/daxing-sample` 及其进程、端口和数据不被触碰；
- TLS 证书有效、覆盖 `DX_REWORK_SERVER_NAME`，私钥权限安全；
- `.env`、`deploy.env`、`restore.env` 均为受控普通文件，缺失值不得继承历史 shell；
- 生产配置不存在 placeholder，Git SHA 为 40 位，BUILD_TIME 合法；
- 数据库、OSS、钉钉和 Todo runtime 按“完整配置或明确关闭”处理；
- 任何缺失、漂移、路径越界、软链接、版本不匹配或密钥疑似泄露立即停止。

部署模式必须通过 `DX_REWORK_NGINX_MODE=shared_path|dedicated_vhost` 显式指定，禁止根据 hostname 猜测。

`shared_path` 额外硬门槛：

- `APP_BASE_PATH=/rework/`；
- 当前 Pilot 允许 `DX_REWORK_SERVER_NAME=staging-api.dxerp.org.cn`；
- 实际 Nginx 配置与 `nginx -T` 都必须包含唯一、可审查的 `DX_REWORK_SHARED_PATHS` 标记块；
- 标记块只能声明 `/rework`、`/rework/**` locations，不得创建 `server {}`、`listen`、`server_name`、TLS 或共享根路径；
- `/rework/api/` upstream 只能为 `127.0.0.1:3201`；
- `/rework/assets/` 与 SPA 只能读取 `/opt/dx-rework/frontend/current`；缺失 asset 必须非 HTML 404；
- DingTalk QR relay 与 legacy callback 精确路径必须关闭 request-line access/error 日志；
- `release-switch.lock` 只能在返工 `/rework/**` locations 内返回 503，不得位于共享 `server {}` 顶层；
- 共享 origin 的其他路径不得被返工 preflight、smoke 或 release 接管。

`dedicated_vhost` 继续保留原独立 server/TLS/维护闸门门禁，shared-path 支持不得弱化它。

脚本不得猜测主机、账号、数据库、bucket、corpId、人员 ID 或密钥。

### 4.3 发布顺序与故障隔离

固定顺序：

1. 获取并核验精确 current main SHA；
2. 在隔离 runner 构建并校验 checksum-bound transfer bundle；
3. 目标机 preflight 在任何数据库变更之前通过；
4. 安装 inactive release 并登记 generation；
5. 验证 migration manifest 与数据库历史为精确前缀；
6. 执行发布前 PostgreSQL 原子备份并校验 checksum；
7. 有 pending migration 时必须显式 `apply_migrations=true` 后前向应用；
8. migration 完成后验证完整 history/checksum 与数据库 readiness；
9. activation 仅切换返工 `active` generation，reload/start 仅限 `dx-rework-api`；
10. 本地 3201 smoke 后解除返工维护闸门；
11. 执行外部 `/rework/` Web 与 `/rework/api/` API smoke；
12. smoke 失败按数据库兼容性决定恢复上一 generation 或进入人工恢复，保留全部证据。

不得 restart/reload/kill ERP 或样衣系统进程。routine release 不运行 `nginx -s reload`。不得通过删除历史 migration、清空数据库、跳过 readiness 或降低守卫换取成功。

当前已知数据库从 `0032_erp_integration_contract` 升级至包含 PR-31 的 `0033_employee_access_management` 存在 pending migration，因此首个当前-main Pilot 发布预期需要 `apply_migrations=true`；最终仍以发布时数据库前缀检查为唯一事实。

### 4.4 冒烟与上线核验

本地 API activation smoke：

- `http://127.0.0.1:3201/version`；
- `/health/live`、`/health/ready`；
- Git SHA、expected schema、actual schema；
- PM2 进程名、cwd、启动脚本与单一在线实例。

shared-path 外部 smoke 只验证：

- `https://staging-api.dxerp.org.cn/rework/` 首页；
- `/rework/auth/login` 与 SPA 深链；
- `/rework/assets/*` 真实静态资源、gzip、缺失 asset 非 HTML 404；
- `/rework/api/version`、`/rework/api/health/live`、`/rework/api/health/ready`；
- QR relay/callback 日志脱敏；
- 安全响应头；
- 不探测、不修改与返工无关的 shared-origin 根路径。

真实数据库只读、OSS 私有上传/下载、钉钉移动免登/电脑扫码、Todo 仅在明确授权的隔离 smoke 中执行；日志不得输出 token、secret、session、签名 URL 或完整上游敏感响应。

### 4.5 备份与隔离恢复

1. 保留 custom-format `pg_dump` 与 SHA-256 manifest。
2. 恢复脚本只允许恢复到明确标记的隔离数据库；默认拒绝当前业务数据库、同名数据库、空目标和无法确认的连接。
3. 恢复前校验 checksum；恢复后运行 migration history、schema、readiness 和最小数据一致性检查。
4. 记录备份时间、恢复开始/结束时间、RPO、RTO、源/目标数据库脱敏指纹及结果。
5. “备份文件生成成功”不能替代真实恢复演练。

### 4.6 回滚

1. 只允许回滚到已登记、checksum 完整、与数据库 schema 兼容的上一有效 Git SHA release。
2. 回滚前后记录 active/current、PM2、version、ready 和 smoke 结果。
3. migration 默认为 forward-only；若数据库已前移且旧代码不兼容，禁止盲目切回旧代码。
4. 回滚失败时停止自动尝试，保持现场证据并进入人工故障处置。
5. shared-path maintenance 只能影响 `/rework/**`；若发现 ERP/样衣或其他 staging 路径受影响，视为跨系统 P0，立即停止并进入独立 Nginx 基础设施处置。

### 4.7 日志与轮转

- Nginx 返工 access/API/deploy/backup/restore/acceptance 日志使用独立路径；
- shared origin 现有其他服务日志不得被返工 release 改写；
- logrotate 配置必须通过 dry-run 和 force 演练，验证轮转、压缩、保留期及进程继续写入；
- 返工 access log 不记录 query string 或 Referer；QR credential-bearing exact locations关闭 request-line 日志；
- 所有脚本输出结构化、脱敏、可关联 Git SHA/Run ID/request ID。

### 4.8 GitHub 手动发布工作流

- 仅 `workflow_dispatch`，默认只做 dry-run；
- 使用受保护 environment、最小权限、并发锁、精确 SHA 输入和环境批准；
- Secrets 只通过 GitHub Environment 注入，不输出或写入 artifact；
- 不允许普通 PR 自动触发真实部署；
- 一个运行只能操作返工独立目录、进程、数据库及已批准 `/rework/**` 路由；
- workflow 不负责安装/reload Nginx；
- 失败必须使检查失败，不得把失败降级为“未启用”或“跳过”。

### 4.9 22 项业务验收矩阵

建立固定 ID `UAT-01` 至 `UAT-22`，逐项对应需求 v1.2 第 13 节：

1. 单工序、单工人、加工厂全额承担并成功扣款；
2. 多工序、多工人、分批上数、整单审核；
3. 一个工序由多个责任方按比例承担；
4. 多人同时上数且累计不超量；
5. 7 人集体计件生成 7 条工资明细且合计等于组总额；
6. 成员后续变化不影响历史分摊；
7. 上数驳回、修改、重新提交；
8. 整单审核后通过调整记录更正数量；
9. 李总审批本厂承担，伍总知会且不能重复审批；
10. 伍总审批本厂承担，李总知会且不能重复审批；
11. 张文豪可查看、判责和提交但不能最终审批本厂承担；
12. 三人 Dashboard 事实一致、按钮按权限区分；
13. 跟单修改责任/倍率并触发生产管理重新确认；
14. 供应商部分扣款；
15. 扣款失败后差额改为本厂承担；
16. 临时工由李同生或授权人员代录；
17. 月份锁定后只能生成下期调整；
18. 非公司钉钉组织账号被拒绝；
19. 离职/禁用员工不能登录但历史可查；
20. 移动免登和电脑扫码登录；
21. 消息深链直达且重试不重复待办；
22. Excel 明细与系统逐行舍入口径一致。

每项证据必须包含：执行环境、Git SHA、数据库 schema、测试数据 ID、角色、步骤、预期、实际、截图/日志/导出引用、执行人、复核人、时间、结果和缺陷链接。不得只以“测试通过”文字替代证据。

### 4.10 试点、培训与上线手册

- 试点范围固定为达兴广州尾部、少量工序、2 名工人；
- 参与角色覆盖品控、李同生、郎飞、张文豪/李总、伍云峰、跟单、梁少萍、欧阳俊珺及相关应付会计；
- 培训材料按角色拆分，目标时长约 2 小时；
- 记录试点起止、问题、处理、回归和签字；
- 上线手册包含发布、观察、故障分级、回滚、恢复、联系人和停止条件；
- S-04 必须在试点前书面关闭，代码和脚本不得替业务做决定。

## 5. 明确禁止

- 不修改 ERP 或样衣系统仓库、目录、进程、数据库和密钥；
- shared staging 仅允许增量维护已批准的 `/rework/**` locations，禁止覆盖、删除或重构其他 staging/ERP/样衣 location；
- routine release 禁止 reload Nginx；任何 Nginx 变更必须独立窗口、备份、`nginx -t`、批准后 graceful reload；
- 不提交真实 `.env`、SSH key、数据库 URL、OSS、钉钉凭据或实名稳定 ID；
- 不连接或启用生产 ERP adapter；
- 不自动执行历史补建 apply；
- 不删除、重写或 squash 已合并 migration；
- 不改变调色盘、业务 UI、金额算法、角色权限或审批流程；
- 不在没有真实恢复和回滚证据时宣称可上线。

## 6. 外部前置项与停止条件

以下事实必须由业务负责人或基础设施负责人提供或在现场只读验证，脚本只校验、不猜测：

- `staging-api.dxerp.org.cn` 当前 TLS 证书/私钥路径与覆盖关系；
- shared staging 真实 Nginx 配置文件路径、`DX_REWORK_SHARED_PATHS` 标记块及单独基础设施维护窗口；
- ECS host、低权限 SSH 用户、host key；
- PostgreSQL 当前业务库与隔离恢复演练实例及最小权限账号；
- OSS、钉钉与 Todo runtime 的完整运行配置；
- system_admin、总 Q、跟单验收代表及实名角色绑定；
- 首批工序、供应商和 5—10 张脱敏真实返工单；
- S-04 书面结论；
- 试点和正式上线签字人。

缺少 shared Nginx/TLS/SSH/数据库事实阻塞真实部署；缺少实名/UAT资料和 S-04 阻塞试点；不阻塞纯代码 CI。

## 7. 代码门禁

至少运行并记录：

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
npm run db:migrate:lint
npm run db:migrate:check
npm run secret:scan
npm run preview:dry-run
find scripts -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n
git diff --check
```

没有真实 PostgreSQL、Nginx 或隔离环境时不得把 migration replay、shared Nginx preflight、恢复/回滚演练写成通过；只能明确标记待 GitHub CI 或现场验证。

## 8. PR-17 完成门槛

代码层完成不等于 PR-17 上线闭环完成。最终上线需同时满足：

- 待部署 Exact main SHA 所有必需 CI 全绿；
- 当前有效的部署修复 Review P1/P2 已关闭；
- shared-path Nginx 基础设施窗口已完成且其他 staging 路径未受影响；
- ECS 精确 SHA 部署成功；
- PostgreSQL 备份、隔离恢复和回滚演练成功；
- PM2、日志轮转、OSS、钉钉和 Todo smoke 通过；
- 22 项 UAT 有双人证据；
- S-04 已关闭；
- 广州尾部试点通过、培训完成、业务签字；
- 正式上线窗口另行批准。
