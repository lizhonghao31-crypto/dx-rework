# 外发退回纠错施工记录

- Repository: lizhonghao31-crypto/dx-rework
- Base: main / 1d52142195b3c9370fb815099adc6a2283ebda7f
- Branch: fix/sourcing-merchandiser-correction
- Gate: FULL（权限、状态流转、数量、追加式数据迁移）
- Scope: 老板在首次批准前退回原跟单修改；日期前后端校验；原始事实与历史版本保留；流程累计用时不清零。
- Allowed files: sourcing contracts/routes/service/UI/validation, workflow timing projection, cutting approved snapshot read, migration 0206 + manifest, corresponding tests and requirements.
- Forbidden: unrelated UI rollout, data sandbox, production records, budget correction permissions, deployment configuration.

## 验证

本地类型检查、定向 lint、migration lint、45 项 contracts/routes/validation 测试通过。PGlite 定向业务链 3 项通过，覆盖连续两次退回后重审、历史原始数量与旧 IE 版本保留、批准后禁止直接退回、裁床读取和历史图片回归。PGlite 单连接不能证明 PostgreSQL 并发，真实数据库门禁以当前 PR Full Gate 为准。未声称完成线上或手机视觉验收。

## 上线与回退

部署必须同时应用 0206 migration 和本次代码。无历史订单回填或改写。出现问题优先关闭新增入口并前滚修复；已有纠错记录后不能直接删表或把应用回滚至不认识纠错状态的旧版本。
