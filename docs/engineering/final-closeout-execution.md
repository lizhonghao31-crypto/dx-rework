# 最终启动收口约束：最小实施记录

目标分支基线：`4b73aae825841e884744e680bb07e6b23856c9d8`。本PR只增强现有操作员request-final入口及其长期引用，不修改业务功能、SQL、CI运行时、身份认证或保护设置。另一分支独立基线/PR，不能将release业务代码带入main。

## 已验证的入口与反例

- 实际新增位置：pr-gate-controller.mjs requestFinal，新建不可变引用前调用final-closeout；preview及apply共用。已有引用继续只观察，不要求追补包。
- 包绑定真实repository/pr/head/base/baseRef/kind，并从固定head原API重读construction-evidence原字节；日志和TAP/Vitest报告按实际摘要、结果数量、具体通过用例核验。已知Codex inline发现须列入，人工定点由本批负责人收口，每条影响规则须有真实结果。
- 缺包、旧head/base、未闭合、报告篡改、固定记录替换、遗漏Review发现、空/失败/全跳过均拒绝；有效真实报告只创建一次。所有反例运行原requestFinal，而非只调用纯函数或伪称UI/现场验收。
- 旧消费者：原请求预览/并发原子创建、Review/threads/light/基线漂移及合并核证保持；原新建请求测试夹具补真实外置包。main无release专用controller套件，使用共享新入口测试及main已有协议测试，不盲拷缺依赖文件。

实际本地命令/时间/日志摘要和源码输入指纹详见同提交construction-evidence.json：

- ["node","scripts/test-preflight.mjs"]
- 开始2026-11-02T01:56:39.111Z，结束2026-11-02T01:56:42.109Z，exit0，150通过/0失败/0跳过。
- 日志/workspace/dx-closeout-records/dx-closeout-release-20261102/native-protocol-1793584599111.log，SHA256 e82c057f4c726231aefb28d2d744db48e35abaf6aec5f789a48a71f4e06981bd。本地Node22.23.4，不声称与远端硬件等价。

## 明确边界和回退

本地文件及摘要不认证作者身份，也不能证明未知问题全部发现；有写权限者仍可能直接创建合法ref绕开规定工具。本次不新增远端传输/存储/认证系统。启动负责人向其他实际施工窗口通知合并版本；合并规则不代表所有旧窗口自动更新。

无数据库或业务数据迁移；必要回退整组operator脚本/文档即可，已创建引用保持不可变并继续按原状态观察，不删除或重写引用。不要用回退消除已知未闭合问题。当前只记录真实本地验证，light、唯一Review、父级本批收口、最终Gate和合并以对应PR实际回执为准，不能提前称完成。
