# R3：Journey JSON 导出白名单

## 一次施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1（用户本轮明确授权）
- base SHA: e4aefc92ceaf73417e8424b8d71dd712380b3f15
- working branch: fix/r3-journey-export-scope
- task scope: 对既有全匹配 Journey JSON 导出执行原平台导出守卫。
- allowed files: journey-query.ts、digital-journey-postgres.test.ts、本证据文档。
- forbidden files: 全局角色/capability、access-policy、schema、部署工具、依赖、UI 按钮、首页。
- gate class: FULL（导出权限边界）。
- main 只读基线: 2d4cf6ba183a0f1ce5ac04e5ddfeb60a617479b8。

## 规则与确认依据

[PR02 Journey 契约](../roadmap/ui-reconstruction-v2/pr02-journey.md) 已确认 GET /digital-production/journeys/export 返回同筛选、权限、规则、快照的全部匹配 JSON，且没有分页字段。无 UI 导出按钮是既有范围，不能据此增加 UI，也不能把全集导出当普通分页查询。

[平台权限 Golden Source 第5节](../requirements/platform-permission-golden-source-v1.0.md#5-全局导出权限) 的 PERM-EXPORT-DEFAULT-DENY-001 和 PERM-EXPORT-FIXED-ALLOWLIST-001 覆盖“等价导出能力”，固定通用导出白名单为 Root、老板、生产管理和财务总监。PR02 没有批准普通跟单或设计师的额外导出例外；其中“相同权限”应继续保留原阅读范围，同时执行独立导出权限，而非绕过平台默认拒绝。

## 本地原生复现与最小修复

线上浏览器 ERR_BLOCKED_BY_CLIENT 没有取得 HTTP 响应，不能解释成403或已确认线上越权。没有访问线上隐藏接口或绕过浏览器。

完整246个 migration 的 owned schema 中建立21条 TEST 母单并指定持久化普通跟单。真实 registerDigitalIdentityRoutes / businessActor / RootAuthority / DigitalJourneyQuery 和 PostgreSQL 阅读策略均参与；认证 fixture 从实际 role assignments / role capabilities 读取身份，唯一 Root 由原 bootstrap 与在职身份检查识别。普通跟单 GET /journeys 的自身列表200、total21；旧版 GET /journeys/export 返回200和全量21条 JSON，拒绝断言明确失败。

根因：identity 路由统一以 pattern_room:orders:create 构造 actor，既有 businessActor 仅对 :export capability 调用平台导出守卫；Journey export service 自身也没有守卫。修复只在 export service 的数据库查询前调用既有 assertBusinessExportAllowed(actor.actorRoles)，同时保护 HTTP 和直接 service 调用。list/read、内部 workspace 的全量投影参数、筛选、快照和字段范围均保持原策略；白名单只是必要条件，不授予新角色原本没有的 Journey 阅读权限。

同一原生回归修复后验证：Root JSON200、no-store、page=2仍返回全匹配21条且无分页字段；普通跟单列表仍200，而 JSON导出403/FORBIDDEN；普通设计师403；直接 service 调用普通跟单403；任务、工资数量不变。完整 Journey 原生13/13通过。修复未增加 capability、角色、UI 按钮、审计写入或另一套导出格式。

本地必要检查：导出白名单与 Journey 筛选/座舱/开发工作区/返回导航31/31通过；lint/typecheck/build（原静态业务链77/77）、secret scan、diff check通过。

本例为隔离原生复现；没有部署、ECS、真实数据库或真实订单操作，不宣称 Acceptance 已验证修复。最终 Head 的 FULL Gate、唯一一次 Codex Review、合并SHA以PR交付证据为准。
