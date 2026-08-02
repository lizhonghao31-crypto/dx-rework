# PR-05 施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 4118fe614c48e5690e2901fa780b976859b0a9b3
working branch: codex/pr-05-qc-rework-initiation
task scope: 品控返工草稿、提交、附件、幂等、撤回/取消与全程审计
allowed files: 新增 PR-05 业务模块、0006 迁移、测试、ADR；增量修改 contracts、domain、app/server、Tools 附件下载授权、migration manifest、roadmap 及既有品控发起页
forbidden files: ERP、生产部署、钉钉配置、PR-06 以后工序/计件/责任/审批逻辑、设计 token、其他既有业务页面
```

## 基线核验

- GitHub `main` 与 PR-04 合并提交
  `4118fe614c48e5690e2901fa780b976859b0a9b3` identical。
- PR-05 分支直接从该 SHA 创建，不叠加旧 PR 分支。
- 施工前本地代码、package lock、迁移 manifest 与远端关键 Git blob
  逐项核对；历史快照多余尾部空行已机械规范化，不作为业务改动提交。
- 基线 lint、typecheck、build、109 个测试、迁移静态检查及密钥扫描通过。

## 业务边界

- 已确认：品控发起；草稿、唯一单号、款号/订单号、跟单、加工厂、问题、
  数量、QC 图片/PDF、撤回/取消；一单一个款号；防重复；全程留痕。
- 未确认：S-01 是否包含非 QC 尾部杂事。检索历史会话和需求文件均未找到
  业务选择，因此本 PR 不把方案 A/B 写成已确认结论。
- 不实现 N02 工序配置、IE 审核、工人分配、上数、判责、审批、工资或扣款。

## 验收证据要求

- 本地：lint、typecheck、build、单元/路由测试、迁移 lint、密钥扫描。
- GitHub：当前精确 Head 的 PostgreSQL 16 0001–0006 回放、PostgreSQL
  集成测试、全量测试、构建、治理预检和 Preview build。
- UI：仅增量接入 `/ui/qc/new`；保持现有 token、移动端布局和其他五页行为。
- S-01 在业务验收和合并前必须关闭，未关闭时不得宣称 PR-05 业务验收完成。

## Codex Review P1 修复预检

```text
reviewed head: b0992a0d16766b6ef59497246c0de2f401b10049
task scope: 修复提交响应丢失后的幂等重放，以及 QC 发起页前端角色/能力门禁
allowed files: apps/web/src/App.tsx、auth.tsx、rework-form.tsx、rework-submission.ts；tests/unit/ui-prototype.test.ts、rework-web-behavior.test.ts；本预检记录
forbidden files: 数据库迁移、API 业务规则、设计 token、PR-06 以后模块、生产配置
```

- 提交重试必须在再次保存草稿前重放原 `reworkOrderId`、`expectedVersion`
  与 `Idempotency-Key`；只有草稿保存成功后才清除旧的待确认提交。
- `/ui/qc/new` 在渲染业务表单前同时要求 `quality_control` 角色和
  `rework:initiate` 能力；其他既有页面继续只使用原有组织/角色准入。
- 不改 API 权限规则、数据库状态机、页面布局、设计 token 或业务字段。


## Codex Review P1/P2 修复预检

```text
reviewed head: 518068b2e6b1c03c82433ceb3a6de2617045ec46
task scope: 修复已绑定 QC 证据下载在角色/能力撤销后的越权，以及返工单审计事件快照校验不完整
allowed files: apps/api/src/tools/{routes.ts,attachments.ts}、apps/api/src/rework/service.ts、apps/api/src/server.ts、0006 迁移及清单、公共 Tools/返工 PostgreSQL 回归测试、本预检记录
forbidden files: 返工业务字段、PR-06 以后模块、设计 token、ERP、钉钉或生产部署配置
```

- 已绑定 QC 证据无论上传人是否相同，下载时均须重新验证当前用户仍有
  `quality_control` 角色、`rework:initiate` 能力及该返工单本人归属。
- 返工单写入触发器必须把审计 `after_state` 中的所有业务字段与待写入行逐项核对；
  证据清单仍由既有附件绑定触发器独立核对，避免创建草稿时的先后顺序误判。
