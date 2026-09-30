# 平台建设规则索引 V2.0

状态：维护期索引  
生效日期：2026-09-10  
适用仓库：`lizhonghao31-crypto/dx-rework`

## 1. 当前状态

以下专项建设已经完成，不再作为默认施工路线：

| 领域 | 状态 | 后续处理 |
|---|---|---|
| 样衣系统平台化迁移 | 已完成 | 进入正常维护；历史迁移 PR、旧 SHA、阶段性授权仅作记录 |
| 外发定价 / 供应商中心 / 合同 / 实时生产 | 已完成 | 进入正常维护；不自动恢复旧 SSP 路线 |
| 权限治理 | 已完成 | 以 `platform-permission-golden-source-v1.0.md` 和最新 main 维护 |
| 返工 / 订单回货 | 已运行 | 按新需求增量维护 |

历史 roadmap 不再代表“当前下一步”。

## 2. 新任务读取规则

新窗口先读根 `AGENTS.md` 和施工流程，然后只读取当前任务直接相关的业务 Golden Source：

- 返工、订单回货：`docs/requirements/startup-requirements-v1.2.md`
- 权限：`docs/requirements/platform-permission-golden-source-v1.0.md`
- 样衣：`docs/requirements/sample-system-migration-v1.0.md`
- 外发/供应商/合同/生产：`docs/requirements/sourcing-supplier-production-v1.0.md`
- UI：`docs/requirements/rework-ui-golden-source-v1.0.md`

不要为了普通维护任务完整重读所有历史路线。

## 3. 历史文档处置

已完成项目的需求/迁移文档仍保留，因为其中包含有效业务规则、权限、字段和迁移审计依据；但其中以下内容一律视为历史：

- 当时的 base/head SHA；
- 已完成 PR 序号与“下一 PR”；
- 临时连续施工授权；
- 迁移当天的操作步骤；
- 已被后续 Golden Source 覆盖的旧结论。

除非当前任务明确要求追溯历史，否则这些内容不得触发新施工。

## 4. 路线隔离

不同业务域保持独立。共享权限、身份、导航、待办、附件、审计、UI token 等确需跨域修改时，建立单独共享平台 PR，并按 `AGENTS.md` 判定 Gate。

用户说“停”后不得切换到其他路线继续。
