# PR03 供应商操作安全

## 施工预检与边界

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- initial base SHA: cc6d43ac3601765fdf58e4dc5cd5dc9047855c5a
- final base SHA: 587db6a5e44025149e64e547d41ac2227112eb07（PR02 #415合并后实际读取main；本PR业务文件未被PR02修改）
- working branch: feat/uat-v21-pr03-supplier-safety
- task scope: 详情选择/加载/编辑/保存对象一致性与供应商CSV导入预检、逐行结果和安全重试。
- allowed files: apps/web/src/supplier-center-page.tsx、apps/web/src/master-data-page.tsx、apps/web/src/supplier-import-safety.ts、tests/unit/supplier-import-safety.test.ts、scripts/supplier-safety-preview.mjs、tests/fixtures/supplier-safety-preview.tsx、docs/evidence/uat-v21-pr03-supplier-safety.md、docs/evidence/pr03-supplier/desktop-dirty.jpg、docs/evidence/pr03-supplier/mobile-partial.jpg、docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md。
- forbidden files: 数据库/迁移、后端权限与Root边界、ERP或生产数据、工序业务和定价、外发流程、返工页面、CI/部署配置、依赖与锁文件。

## 已核对根因与实施

供应商详情已有mounted保护，服务端已有行锁和expectedVersion校验。但前端切换时保留旧profile/draft，保存操作按旧profile ID发起，加载中仍可能编辑旧对象。现在选择同步记录stable ID并立即清空详情；详情返回还需与当前选择及历史记录ID一致。加载未就绪不可写；保存同步锁定，字段、切换、刷新、取消禁用，保存结果只应用到原对象。未保存修改在切换/返回/刷新/取消时使用既有应用确认框；离开页面有beforeunload保护。失败保留错误，不自动替用户重放保存。

供应商导入原来仅用data-ready提示预检状态，部分失败后重新执行全部行。现在预检读取最新目录并冻结更新supplierId/expectedVersion、新建唯一系统编码；真正禁用错误/空原因/无待执行行的确认按钮。读文件与执行有同步锁；逐行展示尚未执行、执行中、成功和失败，遇错停止，成功行永不重发。新建失败重试先按冻结编码核对，资料一致才认定此前已落库，不使用名称匹配来认定写入结果；若读取失败则不再次写入。更新失败不默默采用最新版本覆盖，要求重新预检。执行不是整批事务，不宣称原子导入。

后端access/service.ts已读：reviseSupplier在事务内FOR UPDATE并比较expectedVersion；未修改后端。只维护既有4字段供应商CSV导入，没有扩大为完整企业资料采集引擎。工序导入业务字段及API语义保持原样；共享文件读取锁和忙碌时原因输入保护随本次安全修复生效。

## 定向验证

- Vitest 3文件11项通过：新增supplier-import-safety 5项，既有supplier-center-model 4项（含Root允许/非Root拒绝）、master-data-process-pagination 2项。
- 新执行模块与测试strict TypeScript通过；变更源文件、测试、预览脚本/fixture定向ESLint通过。实际两个页面的离线Vite构建通过；完整workspace由当前PR Head Full Gate验证。
- 实际SupplierCenterPage合成请求：A→延迟B→A后释放旧请求，最终显示A；加载中不显示可保存旧详情；脏表单切换出现确认，继续编辑保留输入。
- 合成保存通过表单Enter提交：请求挂起时对象切换、字段、保存按钮均isEnabled=false；释放后原供应商版本1→2且只发1次写请求。浏览器工具的按钮点击未触发表单默认提交，未将这些点击计为成功验证。
- 实际MasterDataPage合成CSV：错误行确认按钮禁用；3行新建第2行503，结果保留第1行成功、第2行失败、第3行未执行；恢复后累计4次POST完成3行，第1行未重复，全部成功后继续按钮禁用。空原因拦截由执行模块单测覆盖。
- 桌面1440×1024与手机390×844 iframe截图见pr03-supplier/；手机内实际内容宽375（含浏览器滚动条），无横向溢出。截图为现有页面/组件与新增安全反馈，不是PR06重做布局的UI确认样板。
- 预览脚本仅替代Shell/导航/登录与HTTP，全部供应商和写入均为合成内存数据，不连接真实数据库；未完成线上UAT或生产审计验证。重现命令：node scripts/supplier-safety-preview.mjs <输出目录>。

## 门禁与回滚

当前PR需Full Gate（对象/版本一致性与写入重试安全）。最终intended Head门禁全绿后按用户授权触发最多一次Codex Review；默认Full Gate最多两次。没有部署与生产数据写入。回滚本PR squash提交即可，无数据库回滚或权限变更。

