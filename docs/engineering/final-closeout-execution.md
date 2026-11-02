# 最终启动收口约束：最小实施记录

目标分支基线：`972e9f095c28674c1d36f4b8b128115a25fcaf12`。本PR只增强现有操作员request-final入口及其长期引用，不修改业务功能、SQL、CI运行时、身份认证或保护设置。另一分支独立基线/PR，不能将release业务代码带入main。

## 已验证的入口与反例

- 实际新增位置：pr-gate-controller.mjs requestFinal，新建不可变引用前调用final-closeout；preview及apply共用。已有引用继续只观察，不要求追补包。
- 包绑定真实repository/pr/head/base/baseRef/kind，并从固定head原API重读construction-evidence原字节；日志和TAP/Vitest报告按实际摘要、结果数量、具体通过用例核验。已知Codex inline发现须列入，人工定点由本批负责人收口，每条影响规则须有真实结果。
- 缺包、旧head/base、未闭合、报告篡改、固定记录替换、遗漏Review发现、空/失败/全跳过均拒绝；有效真实报告只创建一次。所有反例运行原requestFinal，而非只调用纯函数或伪称UI/现场验收。
- 旧消费者：原请求预览/并发原子创建、Review/threads/light/基线漂移及合并核证保持；原新建请求测试夹具补真实外置包。main无release专用controller套件，使用共享新入口测试及main已有协议测试，不盲拷缺依赖文件。

实际本地命令/时间/日志摘要和源码输入指纹详见同提交construction-evidence.json：

- ["node","scripts/test-preflight.mjs"]
- 开始2026-11-02T02:04:07.469Z，结束2026-11-02T02:04:10.496Z，exit0，91通过/0失败/0跳过。
- 日志/workspace/dx-closeout-records/dx-closeout-main-20261102/native-protocol-1793585047469.log，SHA256 b84a5be32289890871e86a700b6c34d19d7111cda86e1f5a09a389fe667d3e0d。本地Node22.23.4，不声称与远端硬件等价。

## 明确边界和回退

本地文件及摘要不认证作者身份，也不能证明未知问题全部发现；有写权限者仍可能直接创建合法ref绕开规定工具。本次不新增远端传输/存储/认证系统。启动负责人向其他实际施工窗口通知合并版本；合并规则不代表所有旧窗口自动更新。

无数据库或业务数据迁移；必要回退整组operator脚本/文档即可，已创建引用保持不可变并继续按原状态观察，不删除或重写引用。不要用回退消除已知未闭合问题。当前只记录真实本地验证，light、唯一Review、父级本批收口、最终Gate和合并以对应PR实际回执为准，不能提前称完成。

## 本轮唯一Review集中修复

Review发现 4438325198：同总数但不属于原命令的报告可能被误接受。现有名称的原命令日志与报告逐一比对用例；只有汇总的日志须采用该次check内固定的resultReports摘要，不接受事后同数量报告。

新两条真实入口反例在原676a8f00代码上实际红测：0过/2失败（Missing expected rejection），日志/workspace/dx-closeout-review-red-676a.log；修后两分支原preflight分别152/91通过，原断言保持。此红测为预期失败证据，不伪称业务或最终Gate失败/通过。
