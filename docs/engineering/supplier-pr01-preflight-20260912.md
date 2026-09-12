# PR01 预检

repository: lizhonghao31-crypto/dx-rework

base branch: main

base SHA: 189d9ad0bc248d516e38b52bc2f2625f146a1e38

working branch: feat/0912-supplier-pr01-maintenance

task scope: 老板/生产正式维护授权与所有正式创建入口数据库防重。

allowed files: 供应商 access API、供应商前端及导航、AcceptanceMatrix、migration/manifest、相关 tests、requirements/engineering 文档。

forbidden files: 生产数据、环境/密钥、部署配置、无关业务模块、依赖升级。

gate class: FULL

完成标准：HTTP/服务/数据库角色与能力交叉验证；Root 保留；其他角色拒绝；正式写入共享名称+类型防重；审计/版本不变；定向测试、Full Gate、一次独立 Review。
