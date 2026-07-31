# dx-rework

内部计件返工上数系统（独立试点）。

## 当前阶段

项目处于启动与基础建设阶段。业务需求以 `docs/requirements/startup-requirements-v1.1.md` 为确认基线；系统先独立运行，同时保留未来接入达兴 ERP 流程节点的边界。

## Golden Source

- GitHub `main`：唯一代码 Golden Source
- Figma「达兴企业 UI 基础库 · Pilot」：UI 基础变量与组件 Golden Source
- Figma「内部计件返工系统 · Product」：产品页面与交互验收载体
- 业务规则不得仅存在于聊天记录，须进入版本化文档后方可施工

## 基本原则

1. 复用 ERP 已验证的钉钉登录、ECS、OSS、CI/CD 与审计经验。
2. 使用增量式 PR；一个 PR 只解决一个明确目标。
3. 业务可用性优先于视觉表现。
4. 人员身份与权限使用稳定 ID 映射，禁止按姓名硬编码。
5. 前端可见性与后端授权必须同时实施。
