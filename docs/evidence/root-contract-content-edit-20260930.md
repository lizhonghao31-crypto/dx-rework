# Root 本单合同内容编辑预检

repository: lizhonghao31-crypto/dx-rework  
base branch: main  
base SHA: 06f4f753ba4361d4cad20d7d30311cbf4a27126c  
working branch: feat/root-contract-edit-finance-lock-20260930  
task scope: 扩展更新合同入口，Root 在财务核对前编辑本单合同内容并生成独立版本。  
allowed files: sourcing 合同服务与路由、附件合同图片读取、相关 web 编辑入口、contracts schema、0219 migration/manifest、定向测试及需求文档。  
forbidden files: 原订单/审批/裁床金额数量写入逻辑、供应商主档权限、部署配置和生产数据。  
gate class: FULL

完成标准：两选项入口；仅核验 Root 可编辑；财务已有核对记录后禁止（含打开后的再次校验）；仅更新单合同 PDF，原事实和历史保留；供应商同步及款号修订保留非对应人工字段；定向检查、Full Gate 和独立 Review。
