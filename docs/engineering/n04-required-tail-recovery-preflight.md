# N04 需要尾查订单卡点恢复施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 03e908faf21e0a8edf3f05c211b15ebad472324a
- working branch: fix/required-tail-orders-stuck-at-n04
- task scope: 当需要尾查的旧订单所有有效任务均已完成但仍停在 N04 时，提供服务端复核后的显式流转入口
- allowed files: N04 报工服务/路由/页面、前向迁移与清单、定向测试
- forbidden files: 免尾查规则、工资金额、责任判定、报价选厂、现有迁移、CSS 与权限目录

## 业务不变量

1. 历史订单继续默认需要尾查；本修复不写入或改变 tail_inspection_required。
2. 按钮仅在 N04 未完成任务为 0 时出现，后端仍重新验证所有有效任务。
3. 需要尾查的订单必须存在已完成且未被驳回的统一尾查任务；否则拒绝流转。
4. 仅尾部主管或 Root 通过既有 work:assign 边界执行，普通工人拒绝。
5. 状态变化、操作者、原因、版本和 N05 待办全部审计。

## 门禁

P1 核心状态流转修复：Quick Gate + Full Gate；全绿后由业务负责人手动触发一次 Codex Review。
