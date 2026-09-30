# PR02 预检

repository: lizhonghao31-crypto/dx-rework

base branch: main（依赖 PR01 合并）

base SHA: PR01 Head 0fdeb56fc7c49f95830524c66648ccf0ce9ad48a；合并后以实际 main 提交为父节点。

working branch: feat/0912-supplier-pr02-onboarding

task scope: 新增供应商申请、单级审批、版本审计、同事务建档与待办。

allowed files: 申请 API/service/contracts/migration、现有供应商建档事务入口、待办 route/module/context、AcceptanceMatrix、相关测试及施工文档。

forbidden files: 生产/ERP 数据、环境/密钥、部署和依赖升级、无关业务流程。

gate class: FULL

完成标准：仅两类跟单提交、本人可见、老板/生产任一审批、退回原因与版本历史、审批快照建档和回滚、跨入口与并发防重、原待办机制关闭同伴任务及回到申请详情。
