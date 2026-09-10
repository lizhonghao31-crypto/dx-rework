# B方案 PR01：差异处理图片凭证

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: aa59b29792b2efd65b606389de5a88038653346b
- working branch: work/b-plan-pr01-difference-evidence
- task scope: 在现有收货差异和装箱差异处理弹窗内增加可选图片上传、审计绑定及回看。
- allowed files: receiving-service/routes、server 的新增附件类型读取分支、order-board-page.tsx/css、0169 migration/manifest、相关测试及本文档/ADR-0022。
- forbidden files: 既有 migration、收货/多次收货/补录流程、返工工资责任计算、其他模块布局、全局 CSS、角色与 capability 定义。
- gate class: FULL
- execution mode: 按本轮施工计划逐 PR 验收，PR01 达到交付状态后再进入后续 PR。

## 业务决定

- 图片选填，沿用现有收货图片准备、上传、校验与预览能力，最多3张。
- 每张图片绑定到对应差异处理记录，独立于送货单附件。处理人和时间来自真实登录用户及数据库。
- 图片全部上传并校验成功后才提交处理；失败留在原弹窗，重试复用已成功上传的图片。
- 处理结果与图片绑定在同一事务提交。旧记录无图正常，历史记录不覆盖。
- 本轮全系统金额继续最多2位显示，PR01不修改金额算法。
- 后续批量录入必须继承单条新增的权限、校验及现有审批。已扣款后改判产生退款/抵账/冲销不在本轮范围。

## 验收

两种差异分别覆盖无图、单图、多图、失败后重试、重复点击、原处理人/时间回看和旧无图记录。
后端覆盖未上传完成、非图片、非本人、已绑定附件、非法ID、数量限制及无权角色拒绝。
检查处理凭证不出现在送货单附件中，数量变更不会改写历史处理或图片。
桌面及手机检查原按钮位置不变、弹窗无溢出、图片预览可关闭并返回处理记录。
