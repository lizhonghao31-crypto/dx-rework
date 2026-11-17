# CI治理优化重建验收

用户要求撤销#1014后完整重验。#1015的撤销合并为f56ad99c1a574cebae18d47b641d000be6233efc，tree与#1013的7dbd07f0完全一致。本分支从实际撤销merge开始，恢复原de663f03的18文件优化，再补策略修正；没有改生产SQL或业务运行算法，RP3/RP5未提交工作区不动。

原#1014 Light44059176887在Verify Actions usage policy失败：workflow已使用git diff --no-renames --name-only，校验器仍仅接受旧文本git diff --name-only。原失败及未运行后续保留，不重跑该PR的Light。

修正同时覆盖Quick和Full的真实分类step：只接受冻结BASE_SHA/HEAD_SHA、保留重命名两侧路径、输出至各自清单的命令行。缺no-renames、显式find-renames、可变base/head、过滤删除、错误输出或仅注释中的正确文字均被拒绝。没有放宽策略或取消原必要检查。

已核全局四个分类/核证生产者：ci.yml、full-gate.yml、ci-gate-runtime及full-gate-lanes均有no-renames。其它git diff调用逐一属于lint/语法用例发现、迁移历史、部署清单、工作区状态/证据采集；本次没有借机改它们或生产维护脚本。

保留准备边界：正向preparationPath显式限定none/in_house/stopAtReady及无其它分支，默认完整scenario路径不变；拒绝再批准的独有覆盖留在原完整调用。navigation profile只供原导航用例，要求原认证App明确空结果及加载结束，默认home及规模/照片/日历前置不变。陌生设计师保留真实有效身份，省掉无关订单，不用失效会话代授权拒绝。合同/预算回滚用例只省去不消费的后续完工，原故障、事务回滚及重放断言保留。

本地Node22.22.2必要验证：策略命令通过，全部CI协议284/284、风险映射132/132、15个改动源码文件lint通过。日志与源码指纹见当前construction-evidence和私有/workspace/ci-governance-revalidated-20261117/checks。没有本地真实PG/浏览器或性能实验，这些检查不能冒充Full或业务现场通过。新PR首次Light与必要Review并行，收齐发现处理后冻结准确Head/base，再请求最终Full；通过后按授权合并，不部署。

原选测的静态45/49清单仍只说明固定diff计划范围，不是实测性能。此次CI治理变更本身保守采用完整必要计划，不以该profile缩减自身验证。没有新增runner、分片、worker、连接池或benchmark。
