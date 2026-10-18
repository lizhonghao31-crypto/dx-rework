# G1 卡片修复与 G2 组合交付（2026-10-18）

用户于 2026-10-18 13:34:39 UTC 确认将 #804 与 G2 六项合并后一次更新验收。范围固定为 #804、#787、#788、#789、#790、#791、#792，不包含 G3/G4 #793–801 或 main 小改 #802。本轮仅工程组合、门禁与获准合并；不部署、不重启、不操作线上数据库或真实订单。

## 冻结基线与原证据

- release：`3a5605cc65b3e39e8b281bb79feeed0a1598ea1b`。
- 远端 main：`728007c76270614eda15635dea325b7612d7def4`。保留 #803 已纳入的 main 0226/0227 及既有业务修复；不干预该发布任务。
- 本地按 #804 → #787 → #788 → #789 → #790 → #791 → #792 依赖顺序创建真实 merge commits，保留全部原 Head 为祖先。

| PR | 冻结原 Head | 原当前 Head Gate | 原唯一 Review Head | 原线程 |
| --- | --- | --- | --- | --- |
| #804 | `c071ce3b0c1f2f452aaaa4b6f6886713ba119641` | [39131594725](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/39131594725) | `c071ce3b0c1f2f452aaaa4b6f6886713ba119641` | 0 未解决 |
| #787 | `d381833f397495d16725465ce14cce0b9a4ff57a` | [39038690073](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/39038690073) | `3bb9a5b49a99c70e9b5533da3da5e22787b22f6f` | 0 未解决 |
| #788 | `1782b7b8ac378343a2d83e7305dc2cf4adce5c38` | [39022115941](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/39022115941) | `844641be2457c8ddd2a5f64e466c9addefb6d717` | 0 未解决 |
| #789 | `383f5030bc295944649551ff3bc4cc6252b2533d` | [39025154434](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/39025154434) | `d42077dd66d53a56c5b9f8a87cb68db6b2d65285` | 0 未解决 |
| #790 | `17feb18f996997fd6f1b56471f6ca0edb716c0bb` | [39027480657](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/39027480657) | `add259f79ffac4f94a514e7a685476d808b891c5` | 0 未解决 |
| #791 | `0c848a0b64a8324d0d4deddda06dfc2574d0a6b0` | [39028847156](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/39028847156) | `bbab97702ae12e0f0385807e19e48f14dfde05e1` | 0 未解决 |
| #792 | `cb1be523b4f019a1ee15b2e7e3b6601de86f654a` | [39029210499](https://github.com/lizhonghao31-crypto/dx-rework/actions/runs/39029210499) | `cb1be523b4f019a1ee15b2e7e3b6601de86f654a` | 0 未解决 |

部分 PR 的定向修复发生在原 Review 之后；原 finding 已有回归、父核 diff 和修复 Head Gate，线程现已关闭。这里不声称新修复被第二次 Review 审过。七项不重复请求 Codex Review。整合仅叠合已审能力，不新增业务判断、权限、状态机或工资规则；原核心路线与附件授权产品改动按各自原 Head 原样保留。

## 冲突处理与组合门禁

1. 大货详情同时保留 #804 的只读标识/任务时间、#789 的指定 PO 锚点及裁床往返来源。
2. 大货列表同时保留 #804 私有卡片和 #790 的 Error/加载/空态及 listRetry；列表重试不更改详情 key 或重挂载。
3. 开发 execution 同时保留 #788 的 uncertainWrite、原幂等键与写后核实保护，以及 #790 的读取/人员选项独立失败与重试。只有主事实成功重新读取才清除“结果未核实”；选项错误与写错误分别显示。
4. 工作台同时保留原回执、编辑清旧回执、未知写结果保护、#789 的页签/资料上下文和 #790 的读取恢复。
5. 资料容器同时保留 #789 的版本/章节/类别选择、合法来源、离开保护与 #790 的目录重试。
6. 附件接入保留 PR01 已验收的草稿品类保存/清空能力；开发事实同时保留附件身份及各读取独立恢复。
7. 外发日期 token 与附件单行省略/原预览完整名称两组私有 CSS 均保留。

本地全量无运行 DB 测试、类型/lint/build 和实际组件合成浏览器先完成，再集中推送 intended Head。CI 使用 FULL：含原路线服务及附件授权后端，需当前组合 Head 的源兼容检查和隔离 PostgreSQL 业务链；不因旧单包全绿免除组合门禁。没有新增迁移、依赖、scripts/infra 或 CI 策略，部署敏感重型演练不属于本次 diff。

现有 Full Gate 只在 PR 事件上运行，没有手动分支触发入口。集成 PR 因而承载这七项的完整组合及一次最终 Full Gate；不使用修改 CI、空提交或重复更新七个原 Head 的方式触发验证。通过后用保留历史的 merge 方式将组合整体纳入 release，核对七个原 Head 可达、原 PR 状态、最终 release tree 与已测树一致，再冻结一个 Acceptance 目标。这个集成 PR 不增加业务施工包。

组合回归覆盖：原 PR01 草稿两个视口各 10 类、回执两个视口各 11 类、来源两路径×两视口各 7 类、读取两个视口各 13 类、控件实际宿主六组、附件三视口各 7 类及旧外发三视口各 3 类；#804 的六视口 90 卡/180 次链接激活与详情信息保留继续在组合上执行。测试均用实际产品组件和合成拦截数据，不冒充现场请求、真人/真设备验收。具体结果以本 PR 冻结 Head 对应日志与 JSON 为准。

## 更新交付及验收边界

原 3a 工具的 `verify-tool-refresh.py` 检查候选 scripts/infra/依赖和 255 个迁移指纹，保持原只允许数据刷新规则；另用当前 main、原 release 基线和组合候选精确 SHA 做源码兼容检查。未新增安装器、更新链路或自动部署研究。

交付时提供最终实际合并的 40 位 release SHA 及原 `dx-acceptance update <SHA>` 指令；本轮不执行该指令。更新由用户进行，父窗口负责云浏览器验收。合并、Gate、组件回归和现场验收分别记录，G1 卡片尚未现场复测，G2 仍是工程验证，均不能据此记为 Acceptance 通过。

用户已撤销两项追加变价串联/历史快照差异补测，按已有证据与用户豁免放行。停止通知送达前自然结束的隔离 3a 产品测试为 2 通过/138 跳过，自有容器已清理；它与用户豁免是不同事实，也不混入 G2 测试或业务变更。
