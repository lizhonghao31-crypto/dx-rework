# UAT PR04 施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1；PR03合并基线 39cbe7df76040b24821d767d7e2dcff8a8003a3b。
- working branch: fix/uat-pr04-development-editor
- task scope: 同一开发单的对齐栅格、打板品类／尺寸模板、分类附件入口、材料类型／到料编辑与字段定位。
- allowed files: development-document-fields、create/panel、development-pattern-link、限定CSS、相关字段与浏览器验证、业务规则文档。
- forbidden files: ECS/部署/网络、真实数据、工资历史重算、来源模型重写及其它页面全局样式。
- gate class: FULL；最终Head门禁全绿后一次GitHub Codex Review。

## 实现与边界

同一开发 document 复用共同字段；图片区／打板信息与唛类、材料／尺寸表在精确栅格中对齐，长材料与尺寸仅在各自表内滚动。打板品类和原报价版本在上方，尺寸模板独立在尺寸区域；明确确认替换，保留取消与撤回，文档版本变化重置临时撤回状态，避免跨轮次恢复错误内容。

单一“＋”先选主款图／局部图／菲林图／工艺开发板，再选择文件；保留原存储枚举与附件ID，普通款图必须图片，后两类沿原PDF服务预览／下载。删除重复底部上传与资料跳转壳。材料固定分类另列，品名／规格／技术字段自由填写；已有实物与预计计划经过明确确认，原日期保留并停用编辑，取消后恢复。制作说明移到图片区，只渲染一份。公开API、字段模型、价格／工资、原发布／复版及历史打印未重写。

## 验证

- 全量Lint、web类型、web build、secret scan和diff check通过。
- 开发／PO日期／上传／复版定向单元测试6文件28项通过。
- 实际build App＋隔离API：1440×900／1600×900栅格对应边界0px差，页面和材料表无横向溢出；6材料、上衣／裤子模板取消与撤回、英寸分数字符、实物确认取消／保留原计划／恢复编辑、单一四类附件入口、两类PDF、原ID与分类不变、打印内容完整。
- 浏览器100行材料、30附件上限时新增入口禁用，仍可读取已有明细。
- 与CI相同的无数据库全套：448文件通过、61按条件跳过；2311测试通过、544按条件跳过。
- 统一新建入口继续通过完整PR03隔离浏览器链：上传失败与重试、草稿重开、两个PO不同数量／日期、版本保护、发布后确认失败重试只发布一次。
- 两桌面视口截图逐张目视检查；另补390px控件／长表溢出验证通过：/workspace/uat-pr04-evidence/editor-1440.png、editor-1600.png；结果 /workspace/uat-pr04-evidence/result.json。统一建单结果 /workspace/uat-pr04-unified-evidence/result.json。

所有浏览器数据为TEST合成资料，不代表在线部署或业务验收。PR03已合并39cbe7df76040b24821d767d7e2dcff8a8003a3b，本分支已同步；接着执行当前PR04 Head的Full Gate与一次必要Review；最终部署由业务负责人执行。
