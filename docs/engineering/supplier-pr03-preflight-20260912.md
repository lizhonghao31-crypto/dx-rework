# PR03 预检

repository: lizhonghao31-crypto/dx-rework

base branch: main（依赖 PR02 合并）

base SHA: PR02 本地完整实现 bbc9973；提交时使用实际 PR02 合并后的 main。

working branch: feat/0912-supplier-pr03-ui

task scope: 供应商申请/审批页面与维护入口角色分流。

allowed files: 供应商页面/表单/model、App 路由与 Shell 供应商导航、对应组件测试和交付文档。

forbidden files: 生产/ERP 数据、环境/密钥、部署配置、依赖升级、无关业务页面。

gate class: FULL

完成标准：老板/生产直接维护，跟单提交/查本人记录/修改重提；审批人查看完整快照，退回必填原因，通过建档；历史与已通过只读；复用表单及样式，移动端 16px 单列，待办返回路径正确。
