# 合同输入纠偏实施与验证 2026-09-05

repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 5b479ddb136a52e025ccd109705514cc4f557aea
working branch: fix/sourcing-contract-inputs
task scope: 节点1性别款式、节点3工艺及承包范围、审批与合同快照、原件模板和可读PDF一次贯通。
allowed files: apps/api/src/sourcing/、apps/api/src/access/routes.ts、apps/api/src/assets/、apps/api/scripts/copy-contract-font.mjs、apps/api/package.json、新增0147迁移与manifest、packages/contracts/src/sourcing.ts、apps/web/src/sourcing-workspace-page.tsx与CSS、对应tests、package.json与lock、本证据。
forbidden files: 已发布0001–0146迁移、返工与样衣业务代码、生产配置与业务数据、SSP-06。

用户本轮明确授权全程修复、跟进门禁、合并失败PR后继续下一PR；早前同一施工任务授权自主触发每PR最多两次Codex Review。本PR不推进SSP-06。

## 实现

- 节点1移除平台订单号录入与工艺。性别下拉男装/女装不预选；款式必填，服务端同一订单事务入库、规范化去重，支持搜选。款式不是款号。一单公共信息进入批准与合同快照。
- 节点3生产管理确认有序工艺及承包范围；沿用版本化工艺库，新增内容权限随办理岗位移动。决定保存工艺ID、名称、版本与顺序；换厂复制已确认决定内容。历史工艺只读兼容。
- 新增0147，不修改旧迁移、已生成PDF及历史审批；旧缺项明确历史未维护。新建模板V2恢复原件甲方名称、地址、签订地点、完整固定条款、不含税与日期业务含义。合同第二条用红字输出承包范围，双方签署日期留空，不冒充已签署。
- 合同JSON与PDF继续白名单映射，排除内部大兴价。字体作为构建资源随API分发，运行时无需系统中文字体、Python或下载字体。

## 验证

- 六个workspace类型检查及build通过；修改文件eslint通过。
- 111项定向测试通过（外发合同/表单/金额、工艺库隔离、外发路由及主数据角色权限）。
- 新PDF测试覆盖1/3/5/20行、长承包范围跨页、全部固定条款、中文字体嵌入、页面边界、内部价格负向断言。
- PDFKit的WOFF/WOFF2直接输入在实渲染中出现缺字，文本测试不能发现；改为同字体的TTF容器后，Poppler/PyMuPDF实际渲染确认中文和红字清晰，原件单款案例为一页，签章区齐全。
- 0147迁移静态序列及checksum通过。PostgreSQL业务链由当前PR Head的Full Gate验证，本地无PostgreSQL，不将跳过当通过。
- 新增/更新数据库测试覆盖性别必填、款式事务去重、权限拒绝、决定/批准/合同字段一致、重复请求与历史不可变。完整Gate结果以GitHub当前Head为准。
- UI新版五尺寸截图仍未完成：当前浏览器只能访问部署中的旧版，本轮不将静态验证等同视觉验收。沿用#397返工参数；本PR新增控件引用同一套表单样式。

## 字体与依赖

PDF生成使用[PDFKit](https://pdfkit.org/docs/text.html)，文本验证使用[Mozilla PDF.js](https://mozilla.github.io/pdf.js/examples/)。字体来自[Fontsource Noto Sans SC 5.3.0](https://fontsource.org/fonts/noto-sans-sc)的chinese-simplified-400-normal.woff，仅通过fontTools解除WOFF容器为TTF，未修改字形；OFL许可随字体保留于assets。字体是运行依赖，不上传用户图片或原合同资料。

## 回滚

回滚应用提交即可恢复旧界面/调用；0147新增表/列保留，禁止删除新业务事实。模板V2和已生成合同保留，不覆盖或修改旧PDF。若需调整条款，新增模板版本。
