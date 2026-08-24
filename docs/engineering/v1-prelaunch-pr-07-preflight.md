# 1.0 上线前 PR-07 施工预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: f855382a8501062e4ecb820013c12bbf7a2a85f6
working branch: feat/v1-prelaunch-responsibility-processing-factory
task scope: N07 自动带入订单加工厂，并收紧责任判定区的信息层级与视觉密度。
allowed files: packages/contracts/src/index.ts; apps/api/src/rework/responsibility-determination-service.ts; apps/web/src/responsibility-determination-panel.tsx; apps/web/src/responsibility-determination.css; tests/unit/*pr-07-responsibility*; docs/engineering/v1-prelaunch-pr-07-preflight.md
forbidden files: migrations/**; packages/domain/**; responsibility state transitions; owner signature; external settlement; permissions; wages; quantities; receiving; DingTalk; Root policy
```

## 根因与边界

- 返工单已经持久化 `processing_factory_type`、供应商 ID 与供应商版本；N07 基础服务也能查询该订单，但响应契约未暴露加工厂，前端无法确定默认供应商。
- 本 PR 只把已锁定的订单加工厂作为 N07 只读上下文返回；不迁移数据、不改变供应商主数据、不绕过供应商有效性校验。
- 当订单加工厂为外部供应商时，选择“加工厂承担”自动带入；当订单为本厂或缺失加工厂时保留手动选择，并给出就地提示。
- 业务仍可主动改选其他有效加工厂，最终保存继续由服务端校验并生成不可变供应商快照。

## UI 原则

- 责任判定区使用一层工序容器和一层责任行，不再叠加相近色块。
- 输入控件、间距和按钮收紧，但移动端触控高度不低于既有标准。
- 红色仅表示比例/校验错误，绿色仅表示可提交；普通字段不使用强调色。
