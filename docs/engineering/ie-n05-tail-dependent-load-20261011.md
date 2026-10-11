# 普通 IE 的 N05 审核区空白补正

Acceptance 已部署57aaf73b/schema0240，普通IE在N05只见单件总价，预核及工序表为空。现场未捕获产品HTTP请求失败，不能据此宣称真实DTO已完整复刻。此PR的最小可复现路径是需要整查、非统一执行的订单。

外层详情与工作区已有process:review，并传递iePrecounts。WholeOrderReviewPanel先取whole-order-review，再在tailInspectionRequired=true且unifiedExecutionRequired=false时请求权限更窄的tail-inspection；普通ie_reviewer+process:review不获该专用接口读取权限。失败后data仍null，旧return null连错误消息也隐藏。原#732 fixture统一设置tailInspectionRequired=false，漏测了这个加载依赖。

仅改变该面板的读取选择和加载反馈：依据auth/me实际businessRoles/capabilities/isRoot，专用整查读取仍严格限现有后端支持的Root、具configure/audit能力的尾主管和具tail_inspection:report的worker。普通IE保留whole-order-review摘要及既有预核输入，不请求整查专用接口，不增加后端权限、执行/确认/工资能力。模块只读继续禁止预核写。已授权整查读取失败时，显示错误并保持无办理数据、无确认操作，不拿不完整数据放行提交。历史数据路径不变。

原57a代码运行新增fixture，在普通IE/N05/需要整查组合稳定失败（工序表等待超时），请求记录包含整查GET。修复后真实React离线mock矩阵为N04/N05×390/1440×IE/Root/尾主管/只读IE×需要/无需整查，共32场景，加摘要500/Root整查500两个失败场景。允许角色保存并读回原预核、原记录保留；只读及尾主管无预核写。N05普通IE不请求专用整查，不出现最终确认和调价输入；Root/尾主管仍请求原整查接口。失败反馈可见且无写请求。用户原Acceptance TEST单不修改、不推进。

本PR不声称已通过线上验收。用户部署补正候选后，由我们对保留的原N05单定点复测；仍需确认实际DTO标志与上述复现路径一致。无migration、网络、部署脚本或业务API变更。Gate按FULL，最终Head绿灯后一次必要Codex Review。
