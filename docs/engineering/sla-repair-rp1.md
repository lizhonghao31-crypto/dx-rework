# SLA RP1：批准范围与补料复核接续

来源为用户经 Dot 授权、独立审核后的 `SLA_14_Issues_Repair_Construction_Plan_v1_20261117.md`，Library 文件 `libfile_fde3_f-30f31be891188191bd354b724a1f15f9_c8d3bf5d609c8191bce6411a30e94d44`，版本 1，FIX01、FIX02。目标分支 `release/digital-production-v1` 的实际基线为 `ba2f72fc78672a7d9b64c509012479be425b6213`；工作分支 `fix/sla-rp1-adoption-recheck`。风险 Full。沿既有授权创建草稿 PR，完成必要 Review 和准确候选 Full 后合并；合并不含部署或现场数据维护授权。

旧 U2 补丁与 CI A/B 实验保留在各自工作区；本 PR 没有采用 CI B、修改测试规则或推进暂停的首页进度条。

## 规则与实现

1. `OrderTimeRequestService.apply` 仍拥有原生命周期事务、审批锁、admission、原生发布及回执。仅原 `development_publish`／`confirm_order` 返回的精确 source/order 且数据库关联相符时，同事务确认该 source 的首次冻结方案并激活资格，再确认 order。缺失或不符的原生 source 拒绝并完整回滚。已有 source 采用与已开始责任不重置；独立开发、直接订单及开发转正式仍走原路径。
2. `DigitalProductionTaskService.executionBlock` 供原写入 `active` 与 `read.canExecute` 共同读取资格、暂停、取消和特殊结案。岗位及任务对象权限继续独立判定，不删除原写入守卫、不借其他订单资格。
3. `DevelopmentExecutionService.check` 在第一次通过核料或补料复核时，将原办理任务作为新纸样任务的显式 predecessor。`developmentTaskTiming` 按该唯一依赖、source、route/version 取可信完成事实，复核不在冻结路线位置中也能正确衔接。证据缺失、歧义、跨来源或跨路线时保持未知；仅无显式材料依赖的旧路线保留原读取回退。原退料事实不消失，其他同类较晚 A 不得替代当前复核。
4. `OrderTimeScopeRecoveryService` 是内部维护适配，未注册 HTTP 入口。Root 必须通过原 `RootAuthority` 的启用、在职和组织绑定核验，客户端角色字符串不足以授权。只读预览验证原申请终态、唯一原命令回执、批准审计、真实 source/order、当前冻结输入指纹和生命周期；source/order 本地方案修订号各自保留，比较全部冻结政策而非强求相同修订号。写入受生命周期锁、预览指纹和 CAS 保护，仅补 effective、另记维护审计及维护幂等回执，不改原业务回执、计划或任务窗口。

## 历史恢复边界

`scripts/acceptance/order-time-scope-recovery.ts` 默认只读，必须显式给 request、Root 用户及组织。仅接受经 `assertTestDatabaseTarget` 核准的新鲜低权限隔离测试库，不读共享 `.env`。`--apply` 还需原预览 fingerprint、独立维护 key、原因文件；未确认错误不输出连接信息或堆栈。

示例（数据库连接由既有隔离 runner 提供，不在命令或日志中打印）：

```sh
NODE_ENV=test node --import tsx scripts/acceptance/order-time-scope-recovery.ts \
  --request-id <原申请UUID> --root-user <真实Root用户UUID> --corporation-id <原组织>
```

本次只在隔离 PG 合成不一致 fixture 验证恢复，不执行现场维护。原 READY 若缺少原 source 冻结方案、原唯一回执或批准关联，工具返回 blocked；不会从当前标准或当前时钟重建历史。故新请求修复通过不能证明旧 READY 已恢复。历史缺依赖的 FIX02 对象同样不在 GET、重放或改 A 时自动补链；仍需原始因果证据和独立维护授权。

## 验证范围

本地使用 Node 22.22.2、npm 10.9.9、PG 16.16，单个精确归属容器，2 CPU／4 GiB；Vitest 沿原 `vitest.business-chain.config.ts`、共享 worker 和 correctness 预算，不增加全局超时。新鲜带安全标记库、低权限角色和原迁移／UAT seed；不连接 Acceptance 或生产。CPU 限额只描述本地边界，不声称与 GitHub 机器等效。

- N1：旧／新框架批准后真实开发文员完成原核料；同公司快照、overrides、批准来源；无关草稿不能办理。原独立开发、direct-order、转正式及已开窗口继承回归保留。
- N2：退料→补料→复核→纸样，验证实际依赖；R 为 `2026-11-21T04:00:00Z`，冻结 72 小时且周日排除得到 D `2026-11-25T04:00:00Z`；06:00 才分派不移动 R。原 key 重放不增纸样；更正复核 A 为 05:00、未知、原 04:00，纸样 R/D 相应更新。
- N3：故障注入在 source 方案已写后阻断 order 方案，核原生订单、任务、两方案、生效资格、批准审计、申请事件和原命令回执均回滚，再用原 key 成功一次；已有审批竞争及异正文拒绝保持。
- 维护：无权、伪造 Root 字符串、停用 Root 身份拒绝；原方案／回执、终止、陈旧指纹均有严格边界；同 key 并发恢复只留一个独立审计，原计划、任务和 deadline revisions 逐行不变。
- 单测补因果唯一性：较晚同类事实不替换明确前置；错来源、错路线、跨轮、歧义及缺完成保持未知。

本地原始报告保留于 `/workspace/sla-rp1-20261117/`；提交内 `construction-evidence.json` 记录准确命令、来源、结果和日志摘要。首次完整请求回归 27 过／2 失败，失败为维护校验错误强求两个资源本地政策修订号一致；已修政策比较及原回执证明并定向验证。前期新 fixture 的标准配置层级、物料预计日和错误使用旧改派入口均保留失败记录，未放宽业务守卫。最终结果以同批实际报告为准。

现场真实认证／交互验收、旧 READY 维护执行、其他 RP 与部署分别记录，不能从本地或 CI 通过推定。
