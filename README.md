# dx-rework

内部计件返工上数系统，独立处理人工创建与本系统业务流程。旧外部 ERP 对接已退役，见[退役范围与历史兼容](docs/engineering/legacy-erp-retirement.md)。

## 当前阶段

业务需求以 `docs/requirements/startup-requirements-v1.2.md` 为确认基线。前端新增、维护、迁移与验收统一查阅[达兴 Astryx UI 规范 1.0](docs/ui/ASTRYX_UI_SPEC.md)。已批准的 Figma 页面作为对应页面的视觉验收证据。

## 工程结构

```text
apps/web          React 19 + Vite 8 独立前端
apps/api          Fastify API、健康检查和版本证据
packages/config   类型化配置与启动校验
packages/contracts 版本化 API 契约
packages/domain   共用领域规则、审计与事件类型
packages/ui       UI 代码边界
infra             独立 Nginx、PM2、logrotate 模板
scripts           数据库迁移、备份与安全检查
```

## 本地验证

要求 Node 22、npm 10 与 PostgreSQL 16。

```bash
npm ci
npm run check
DATABASE_URL=postgresql://... npm run db:migrate:check
```

API 环境变量名见 `.env.example`。真实值不得进入仓库、日志或 PR。

## 健康与版本

- `GET /health/live`：只验证进程存活，不依赖数据库；
- `GET /health/ready`：验证数据库与 migration schema；
- `GET /version`：返回 Git SHA、构建时间、已应用/预期 schema 版本。

## Golden Source

- GitHub `main`：唯一代码 Golden Source；
- `docs/requirements/startup-requirements-v1.2.md`：业务规则基线；
- Figma Product：页面和交互验收载体；
- 需求变化先进入版本化文档或 ADR，再施工。
