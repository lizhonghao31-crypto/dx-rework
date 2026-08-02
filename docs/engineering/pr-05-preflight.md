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
