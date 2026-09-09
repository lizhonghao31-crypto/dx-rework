# 权限施工收口路线 V1.0 — 2026-09-09

## Precheck

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 68ac2e3576c6b4d9d0c64c7be4ce63043dc0778b
working branch: fix/permission-closure-pr01-golden-source
task scope: 将业务负责人已逐项确认的最终权限总表、敏感字段 a–i 与导出规则写入 Golden Source
allowed files: docs/requirements/platform-permission-golden-source-v1.0.md, docs/roadmap/permission-closure-20260909-v1.0.md, docs/requirements/_permission-closure-start.txt
forbidden files: 正式 role_capabilities、业务 API、Service、业务状态机、生产数据、ECS/OSS/钉钉生产配置
```

## 已确认施工顺序

1. PR-01：最终权限 Golden Source 收口。
2. PR-02：全系统导出权限默认拒绝、固定白名单和工资月结会计特例收口；前端、API、Service、浏览器端 CSV/Excel 生成一起治理。
3. PR-03：角色、模块、敏感字段、退役角色以及 Acceptance Matrix/标准 UAT 身份真实权限落地。
4. 全部合并后只运行一次最终 Acceptance Lab 全角色验收；不再用 Lab 反向推导业务标准。

## 连续施工规则

- 业务负责人已明确授权 Work 全程接手，不因普通技术阻断、CI 重试或单个角色问题停工。
- Codex 只做 Review，不用于施工；finding 由 Work 自行修复。
- 不再重新讨论已确认权限，不把已确认规则改回 PENDING。
- 每个 PR 保持单一目标；Gate 以 exact Head 为准，必要 Review 后自行修复并重新 Gate，合并后立即进入下一 PR。
- 不在本轮修改业务状态机、金额计算、生产数据或无关 UI。
