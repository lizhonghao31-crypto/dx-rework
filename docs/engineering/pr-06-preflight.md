# PR-06 施工预检

\`\`\`text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 9109bb67395177c0d858988f50510c52b908a6fb
working branch: codex/pr-06-process-configuration-ie-review
task scope: N02 工序配置、N03 IE审核、自定义工序受控入库与已生效配置变更单
allowed files: 0007迁移/清单、返工配置API与服务、前端工序配置页、contracts/domain、ADR、路线图、需求S-01结论及相关测试
forbidden files: ERP、生产部署、钉钉配置、PR-07分工/上数/计件、PR-08数量调整、责任/审批/工资/扣款、设计token和既有页面布局重构
\`\`\`

## 业务边界

- 仅处理已提交的品控/生产返工；S-01已确认方案A，非QC尾部杂事不纳入。
- 李同生配置工序、计划数量、件/小时单位与单价；郎飞IE通过或驳回。
- 件数必须为整数；小时截断到2位；单价截断到3位，不四舍五入。
- 草稿可重复保存但形成不可变版本；已生效配置只能通过填写原因的新变更单重审。
- 自定义工序仅在IE通过后进入公共工序库；未通过的自定义项不污染目录。

## 验收证据

- 本地：typecheck、lint、build、154项可运行测试、迁移清单、密钥扫描。
- 数据库：PGlite 顺序回放0001–0007，且完成品控发起→配置→IE通过→自定义工序入库的真实事务验证。
- GitHub：当前精确Head的PostgreSQL 16迁移回放、并发/集成测试、构建、治理和Preview。
- UI：新增单一移动端工序配置与IE审核页；仅增量扩展AuthGate的多角色准入，不替换既有设计令牌或六页布局。

## 回滚

未部署时关闭PR即可。0007一旦应用，不修改历史迁移；仅通过后续前向迁移停用入口或修复结构。不得删除返工单、配置版本、IE意见、公共工序映射、附件、审计事件或发件箱记录。

