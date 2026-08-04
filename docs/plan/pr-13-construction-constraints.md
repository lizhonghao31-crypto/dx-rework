# PR-13 施工约束

## 四个受控施工包

1. 数据模型、契约与事件矩阵；
2. 待办核心服务、钉钉适配层、重试与深链；
3. 仅连接事件矩阵内的业务节点；
4. 历史补建、端到端验收与交付文档。

每包完成后必须审查 diff、数据库约束、权限边界与测试证据，才可进入下一包。不得改写 PR-05 至 PR-12 核心状态机、历史 migration、工资/责任/扣款/审批业务规则；不得做 UI、Dashboard、ERP、部署、真实钉钉投递或第二套 outbox。

## 发布与止损

四包完成且本地门禁、完整 diff 审查通过后，才允许创建或更新一个 Draft PR。Exact Head CI 全绿后，先做一次反例审查，再仅触发一次限界 Codex Review；CI 与 Review 各最多一轮集中修复。

出现以下任一项立即停止：第二个不同根因的 CI 失败；需要推翻待办模型、事件语义或权限模型；需要第二套事件系统；大改 PR-05 至 PR-12；Golden Source 缺失；base/head 不一致；超出一次集中收口。

## 施工包 4：受控历史补建

历史状态不得在 migration 内扫描。`0026` 只建 schema、策略和 capability；补建由以下命令完成：

```bash
npm run todos:backfill -- --dry-run
npm run todos:backfill -- --apply --actor-user-id <direct-production-management-user-id>
npm run todos:backfill -- --apply --actor-user-id <direct-production-management-user-id> --resume-run-id <run-id>
```

默认是只读 dry-run。`--apply` 只允许当前直接有效且拥有 `todo:routing_exception_manage` 的 `production_management` 执行。每次 apply 先写入 run ID、数据库时间和 operation-event 高水位；每批独立事务后保存 cursor 和累计计数，resume 使用同一快照与 cursor，并另写 `todo.backfill_run` 审计事件。实时投影和补建共享 dedupe key，重叠时不重复创建待办。输出仅包含 run ID、时间、cursor 与计数，不包含人员凭据或钉钉 token。

## 必测反例

重复业务事件、投递响应丢失、失败重试、已解决待办上的旧超时任务、接收人失效、无权限深链、转交后原接收人操作、任一老板审批后的另一人知会、历史存量、时区/截止时间边界、`system_admin` 越权与 outbox 重放均必须覆盖。
