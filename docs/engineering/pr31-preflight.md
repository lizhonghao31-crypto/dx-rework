# PR-31 施工预检记录

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 69917cba85f0ee74bfb01248cb190c615b490452
working branch: feat/pr31-employee-access-management
task scope: 老板权限组专属员工权限管理、钉钉通讯录同步、访问停用/恢复与首位老板受控初始化
allowed files: apps/api/src/auth/**、apps/api/src/access/**、apps/api/src/app.ts、apps/api/src/server.ts、apps/api/migrations/0033_*、apps/api/src/platform/migration-manifest.json、packages/contracts/**、packages/config/**、apps/web/src/App.tsx、apps/web/src/*employee-access*、apps/web/src/admin-console.css（仅复用/增量样式）、tests/**、docs/engineering/**、docs/operations/**、.env.example（仅新增非秘密变量名/占位说明）
forbidden files: 历史 migration、既有业务工资/责任/扣款/审批规则、ERP 仓库、生产 ECS/RDS/DNS/钉钉后台配置、线上密钥、Figma Golden Source
```

施工基线来自 PR #30 合并后的远端 `main`。本 PR 采用 Incremental Injection：复用现有 `app_users`、`identity_mappings`、`business_roles`、`user_role_assignments`、`auth_sessions`、`operation_events` 与 `access:admin` 基础能力；不重构既有管理员控制台，不修改历史业务事实。

## 已确认安全边界

- 新员工权限管理 UI 与专属 API 仅 `owner_group` 可访问。
- 角色授权继续复用既有受控写入与审计触发器；禁止自授予、禁止非本企业/离职/停用人员授权、禁止撤销最后一名有效老板。
- 钉钉通讯录同步只更新实际返回且可验证的成员，不因应用可见范围导致的“未返回”自动判定离职。
- 访问停用/恢复必须写审计；停用同时撤销现有 Session。
- 首位老板初始化必须默认关闭、一次性、与稳定钉钉身份绑定；仓库与前端不得出现真实 bootstrap 凭据。
