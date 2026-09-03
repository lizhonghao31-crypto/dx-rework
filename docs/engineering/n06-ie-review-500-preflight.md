# N06 IE复核500修复预检

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `b68afa8cb2d71f022d4c7ea46ef8855652c55f30`
- working branch: `fix/n06-ie-review-500-dialog`
- task scope: N06工资金额统一保留三位小数，并为提交失败补系统弹窗与错误编号。
- allowed files: N06服务端、N06前端、对应单元/集成测试、本预检记录。
- forbidden files: 数据库迁移、状态机、权限、公共UI样式、其它业务模块。
