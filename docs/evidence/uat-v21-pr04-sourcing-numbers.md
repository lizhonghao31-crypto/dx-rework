# PR04 数字规范与非转厂外发收口

## 施工预检

- repository: lizhonghao31-crypto/dx-rework
- branch: feat/uat-v21-pr04-sourcing-numbers
- initial base: 587db6a5e44025149e64e547d41ac2227112eb07
- final base: c5154a86fdd3bf71babe4ec5f11e5c261bb4f71f（PR03已合并，相关业务文件未被其修改）
- fixed route: PR04，未重新拆分13条路线。
- allowed: packages/contracts/src/sourcing.ts；apps/web/src/sourcing-workspace-page.tsx、sourcing-price-presentation.ts；apps/api/src/sourcing/sourcing-contract-pdf.ts；tests/unit/sourcing-pr03-contract.test.ts、sourcing-order-craft-contract.test.ts、sourcing-number-presentation.test.ts、sourcing-price-presentation.test.ts、sourcing-contract-number-format.test.ts；tests/integration/sourcing-routes.test.ts；scripts/sourcing-price-preview.mjs；tests/fixtures/sourcing-price-preview.tsx；本证据、pr04-sourcing/desktop.jpg与mobile.jpg、docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md。
- forbidden: 数据库和迁移、历史业务记录、API服务计价算法、转厂逻辑、返工、权限/Root、ERP、CI/部署、依赖和锁文件。

## 实施与事实边界

新订单内部价/逐款对外价、普通IE报价及生产管理报价改为最多两位有效小数；12.3400等存储尾零允许，12.3456明确拒绝，不静默截断。独立新写入schema，历史读取schema、四位精度计算器及RequestSourcingFactoryChangeSchema保留原样。新建API要求至少1个唯一附件ID；既有服务继续验证附件归属及ready状态。页面明确必填图片与内部价，上传中/失败/无图不能提交，finalize必须ready；失败可重新选择上传，未增加生产写操作。

新录入数字聚焦编辑原值、失焦合法值千分位/去尾零；无效超精度输入失焦仍保留原值，避免显示已舍入值而实际提交另一值。逐款预览对非法新报价不再生成具有误导性的金额。未改变原转厂输入及总额计算。

普通多款订单列表、详情和财务摘要明确“多款价 · 见逐款明细”，不以第一行作为全单价格。财务逐款读取既有选厂决定的quantity/unitPrice/totalAmount，不使用全单数量乘首行单价，不改批准事实；原老板逐款表保留。转厂sourceType继续原摘要和路径，不掩盖延期P1。财务核对仍不阻断正式派单和生产。

合同服务既有snapshot.lines与totalAmount来自批准快照，未改合同服务或指纹计算。templateVersion2渲染仅在展示边界加入分组/去尾零；历史四位有效单价原字符串保留，旧版渲染和既有PDF不重写。内部大兴价不进入ContractPdfSnapshot。该PDF渲染文件属于原定合同/财务同事实核验所需展示修正，未改合同金额。

Root删除确认补充所有款色、供应商、数量、订单号及关联影响，技术ID仅辅助；实际逻辑删除服务、审计和权限未变。关联生产单不会自动测试排除，PR05另行处理。

## 验证

- 本地5文件16项通过：新价格/必填/摘要/删除确认5项、合同展示2项、既有工艺契约3项、逐款契约4项、数字展示2项。另既有逻辑删除与图片生命周期2文件7项通过。起初后两文件缺少只读依赖而ENOENT，获取精确main依赖后通过，没有修改这些业务依赖。
- 新增API路由拒绝用例：缺图/空图/内部或外部四位有效价格、IE及管理报价四位有效价格在业务服务前400；完整buildApp集成以及sourcing-pr03-contract服务依赖测试留给最终Head Full Gate，不将未跑本地的测试记为通过。
- 实际SourcingWorkspacePage离线Vite构建通过。替代Shell/Header/会话与HTTP，使用实际业务组件和schema；全部业务写入返回403，不连接数据库。
- 浏览器确认新建无图按钮禁用，必填中文提示可见；数量12345失焦显示12,345，非法12.3456失焦保留12.3456。合法分组及历史精度由上述函数/契约回归覆盖。
- 实际财务页面合成2款：1000×12.3=12300、500×18.5=9250，总数量1500、批准总额21550；财务逐款显示这些既有事实，摘要标为多款价；页面仍说明财务核对不影响派单生产。
- 手机订单卡显示各款价格，删除弹窗展示DX-A/白色、DX-B/蓝色、合成加工厂、1,500件和关联影响。取消确认，无删除请求。
- 截图记录1440×1024桌面及390×844手机iframe；截图为外层可见区域，财务下方事实另外用可访问DOM核对，不宣称截图包含整个流程。重现：node scripts/sourcing-price-preview.mjs <输出目录>。
- 未部署ECS，未进行真实OSS、供应商合同签署、多角色或生产数据UAT；UAT-02待部署后验证新普通报价，UAT-03延期。

## 门禁与回滚

金额/契约变更必须Full Gate；普通PR创建后立即full-gate，最终intended Head全绿后决定并最多一次Codex Review。默认最多两次Full Gate，失败先本地集中诊断。回滚本PR squash提交，无数据迁移回滚。
