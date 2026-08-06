# PR-17：ECS 部署、全链路验收与试点上线（冻结施工契约）

> 路线 ID：`PR-17`
>
> Repository：`lizhonghao31-crypto/dx-rework`
>
> Base：`main@918026f77d20046b3a28aac8c33c9b85ebda5282`
>
> 工作分支：`work/pr-17-ecs-pilot-go-live`
>
> 状态：施工中；只允许一个 Draft PR；未经业务负责人明确授权不得合并或执行真实生产部署。

## 1. 唯一目标

把仓库现有 Nginx、PM2、PostgreSQL 备份、健康检查与 PR 预览安全机制，封闭为一套可审查、可重复、可追溯、可恢复和可回滚的返工系统上线体系，并完成正式上线前的 22 项业务验收、达兴广州尾部小范围试点与证据留存。

本 PR 不开发新的业务模块，不改写已确认的审批、权限、工资、责任、扣款或 ERP 契约事实。

## 2. 分阶段边界

### A. 代码与运维闭环

完成部署脚本、配置模板、受控工作流、备份恢复、回滚、冒烟、验收矩阵与运行手册。该阶段不得连接 ECS、生产 PostgreSQL、真实 OSS 或钉钉，不得写入任何真实密钥。

### B. 隔离环境部署验证

仅在目标域名、TLS、SSH、独立目录、数据库、OSS、钉钉配置及维护窗口均已明确后执行。先完成只读预检，再执行隔离部署、迁移、冒烟、备份恢复和回滚演练。

### C. 达兴广州尾部试点

先选择少量工序和 2 名工人，使用脱敏或明确授权的真实业务资料完成 22 项场景及角色验收。试点前必须关闭 S-04。

### D. 正式上线

必须同时具备：代码门禁全绿、精确 Head 部署证据、22 项验收通过、隔离恢复成功、回滚成功、日志轮转生效、培训完成、试点签字和上线窗口批准。

任一阶段未满足门槛，不得进入下一阶段。

## 3. 允许施工范围

可新增或增量修改：

- `.github/workflows/` 下 PR-17 专用手动发布与验证工作流；
- `scripts/deploy/`、`scripts/acceptance/`、PostgreSQL 备份与隔离恢复脚本；
- `infra/nginx/`、`infra/pm2/`、`infra/logrotate/` 的独立返工系统配置；
- `.env.example`、`package.json` 中与部署验证直接相关的变量名和命令；
- `docs/operations/`、本施工契约及路线图；
- 对应的 unit/integration/structure tests。

只有现有 `/health/live`、`/health/ready`、`/version` 无法支撑精确部署核验时，才允许对技术诊断接口做最小增量修改。不得借机修改业务服务、业务状态机、金额算法、业务 UI 或历史 migration。

## 4. 必须交付

### 4.1 精确 Head 与不可变 Release

1. Release 目录固定为 `/opt/dx-rework/releases/<40位git-sha>`；前端为 `/opt/dx-rework/frontend/releases/<40位git-sha>`。
2. 构建产物生成 manifest，至少记录 Git SHA、构建时间、Node/npm 版本、数据库 schema version、文件 checksum。
3. 部署前验证 GitHub 目标 Head、release 目录名、manifest、`/version.gitSha` 完全一致。
4. 禁止阶段名、时间戳或 `latest` 代替 Git SHA；禁止原地覆盖 release。
5. `current` 和 `frontend/current` 仅可通过受控原子软链接切换。

### 4.2 Fail-closed 部署预检

预检至少验证：

- Linux、Node 22、npm 10、PostgreSQL 客户端、Nginx、PM2、磁盘、内存和端口；
- `/opt/dx-rework` 全部目录边界、属主、权限、非软链接父路径；
- `/opt/daxing-erp`、`/opt/daxing-sample` 及其进程、端口、vhost 不被触碰；
- 独立域名、TLS、Nginx server_name、API 端口 3201；
- `.env` 位于 `/opt/dx-rework/shared/.env` 且权限为 `0600`；
- 生产配置不存在 placeholder，Git SHA 为 40 位，BUILD_TIME 为合法 ISO 时间；
- 数据库、OSS、钉钉和 Todo runtime 配置按“完整配置或明确关闭”处理；
- 任何缺失、漂移、路径越界、软链接、版本不匹配或密钥疑似泄露均立即停止。

脚本不得猜测域名、主机、账号、数据库、bucket、corpId、人员 ID 或密钥。

### 4.3 发布顺序与故障隔离

固定顺序：

1. 获取并核验精确提交；
2. 在隔离 staging 目录构建并校验 checksum；
3. 执行发布前 PostgreSQL 备份并校验 checksum；
4. 验证 migration manifest 与数据库历史；
5. 应用前向 migration；
6. 安装新 release，但不切换 current；
7. 使用新 release 的配置执行启动前检查；
8. 原子切换 API 与前端 current；
9. reload/start 仅限 `dx-rework-api` 和独立返工 vhost；
10. 执行 smoke；
11. smoke 失败自动恢复上一有效 release，并保留失败证据。

不得 restart、reload、kill 或修改 ERP/样衣系统进程与目录。不得通过删除历史 migration、清空数据库、跳过 readiness 或降低守卫换取成功。

### 4.4 冒烟与上线核验

至少验证：

- `nginx -t`；
- PM2 进程名、cwd、脚本、Node 版本和环境；
- `/health/live`、`/health/ready`、`/version`；
- `/version.gitSha`、schema version 与目标 release；
- 前端首页、登录页、真实静态资源、SPA 深链、API 根路径和可选 `/rework/` 前缀；
- OAuth callback 不在 Nginx 请求日志泄露 query；
- 关键响应头、gzip、404 资源不回退为 SPA HTML；
- 数据库只读查询、OSS 私有上传/下载、钉钉登录与 Todo 只在明确授权的隔离 smoke 中执行；
- 日志不输出 token、secret、session、签名 URL 或完整上游敏感响应。

### 4.5 备份与隔离恢复

1. 保留 custom-format `pg_dump` 与 SHA-256 manifest。
2. 新增恢复脚本，只允许恢复到明确标记的隔离数据库；默认拒绝当前生产数据库、同名数据库、空目标和无法确认的连接。
3. 恢复前校验 checksum；恢复后运行 migration history、schema、readiness 和最小数据一致性检查。
4. 记录备份时间、恢复开始/结束时间、RPO、RTO、源/目标数据库的脱敏标识及结果。
5. “备份文件生成成功”不能替代真实恢复演练。

### 4.6 回滚

1. 只允许回滚到已登记、checksum 完整、与数据库 schema 兼容的上一有效 Git SHA release。
2. 回滚前后记录 current 指向、PM2 状态、version、ready 和 smoke 结果。
3. migration 默认为 forward-only；若新代码已执行不可逆 schema 变更，禁止盲目切回不兼容旧代码。
4. 回滚失败时停止自动尝试，保持现场证据并进入人工故障处置。

### 4.7 日志与轮转

- Nginx、API、部署、备份、恢复和验收日志使用独立路径；
- logrotate 配置必须通过 dry-run 和 force 演练，验证轮转、压缩、保留期及进程继续写入；
- 访问日志不得记录 query string 或 Referer；
- 所有脚本输出结构化、脱敏、可关联 Git SHA/Run ID/request ID 的结果。

### 4.8 GitHub 手动发布工作流

- 仅 `workflow_dispatch`，默认只做 dry-run；
- 使用受保护 environment，最小权限、并发锁、精确 SHA 输入和环境批准；
- Secrets 只通过 GitHub Environment 注入，不输出或写入 artifact；
- 不允许普通 PR 自动触发生产部署；
- 一个运行只能操作返工系统独立目录、进程和 vhost；
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

- 不修改 ERP 或样衣系统仓库、目录、进程、vhost、数据库和密钥；
- 不把返工系统加入现有混合 `staging-api.dxerp.org.cn` vhost；
- 不提交真实 `.env`、SSH key、数据库 URL、OSS、钉钉凭据或实名稳定 ID；
- 不连接或启用生产 ERP adapter；
- 不自动执行历史补建 apply；
- 不创建第二个 PR，不并行建设新业务模块；
- 不删除、重写或 squash 已合并 migration；
- 不改变调色盘、业务 UI、金额算法、角色权限或审批流程；
- 不在没有真实恢复和回滚证据时宣称可上线。

## 6. 外部前置项与停止条件

以下事实必须由业务负责人或基础设施负责人提供，脚本只校验、不猜测：

- 独立正式/试点域名、DNS、TLS 证书和安全组；
- ECS host、低权限 SSH 用户、host key 和维护窗口；
- PostgreSQL 生产/恢复演练实例及最小权限账号；
- OSS、钉钉与 Todo runtime 的完整生产配置；
- system_admin、总 Q、跟单验收代表及实名角色绑定；
- 首批工序、供应商和 5—10 张脱敏真实返工单；
- S-04 书面结论；
- 试点和正式上线签字人。

缺少这些内容不阻塞 A 阶段代码施工，但阻塞真实部署、UAT、试点和上线。

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

没有真实 PostgreSQL 时不得把 migration replay 或恢复演练写成通过；只能明确标记待 GitHub CI 或隔离环境验证。

## 8. PR 完成门槛

代码层完成不等于 PR-17 完成。最终 Ready 需同时满足：

- Exact Head 所有 CI 全绿；
- PR-17 唯一一次限界 Codex Review 的有效 P1/P2 已关闭；
- 隔离 ECS 部署成功；
- PostgreSQL 备份、隔离恢复和回滚演练成功；
- Nginx、PM2、日志轮转、OSS、钉钉和 Todo smoke 通过；
- 22 项 UAT 有双人证据；
- S-04 已关闭；
- 广州尾部试点通过、培训完成、业务签字；
- 未执行合并或正式上线，除非业务负责人另行明确授权。
