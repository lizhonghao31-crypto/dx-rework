# DOC-01 成本预算与限定单据基础

依据：用户交付的《三大单据UI与填写交互施工规范 V1.0，2026-10-06》36 页正文及三张原图；正文第 3 页例外优先。文件已留存 Library `libfile_a9cfb3395f7c819187cc2cd02e02cd6c`，SHA256 `86fb14bf7136225d7137374472852ccb19712765ce409e9069388846f80f23e2`。图稿文字不作为业务字段来源。

本次授权集成基线为 `release/digital-production-v1` 的 `e5936dcadb8e881b2c54d638419915da154ad649`。开工最小核对 main 为 `cdabead9d4832bdb86540bcffd32ca880b04f890`，无开放 PR；没有合入 main 的不同迁移历史。DOC-01 → DOC-02 → DOC-03 分别 Full Gate、必要 GitHub Codex Review、合并 release；用户自行部署后一起验收。DOC-01 只改预算与三单据限定作用域的呈现组件，不改后端、Schema、迁移或部署工具。

## 原字段映射

| 来源 | 屏幕 | 原打印 | 写入边界 |
| --- | --- | --- | --- |
| order.customerCode/designStyleNo/productGroup | B02 基础资料 | 原抬头资料 | 原单据只读 |
| sheet.designerName/merchandiserName | B02/B08 | 原设计师/页尾跟单 | 原岗位只读 |
| fabricType/productCategory/monthSeries | B02，100 字原短文本 | 原抬头资料 | 原 canEdit |
| date/currency | B08 单一原生日期控件/B07 人民币 | 原页尾日期/原人民币售价标签 | 日期原契约，币种固定 |
| order.lines[].formalStyleNo/temporaryStyleNo/poNumber/color/sizes[].quantity | B02 默认展开的原款色 PO 矩阵，原优先级和件数求和 | 原款色 PO 表 | 不修改母单或订购数量 |
| rows[].rowId/section | B04–B06 分组；稳定 ID 用于输入、焦点和错误目标 | 按原分组打印全部行 | 完整 document 保留 ID |
| rows[].category/name/specification/unit/supplier | B04–B06 原五列，100 字 | 原五列 | 原短文本契约 |
| rows[].consumption/unitPrice | B04–B06 原十进制字符串 | 原两列 | 非负，最多 6 位小数；空不转 0 |
| calculateBudget.rows/main/accessories/processes | B04–B07 原派生金额 | 原行金额/分组合计 | 不增加金额输入字段 |
| freight/cm/salePrice | B07 原三项 | 原费用/售价 | 原十进制字符串 |
| calculateBudget.cost/profit | B07 原结果，2 位显示 | 原成本/利润 | 原 12 位乘积精度；无售价为未知 |
| outsourcingScope/outsourcingUnitPrice | B08，范围最多 1000 字 | 原外发范围/预算价 | 原发布价最多 2 位有效小数 |
| imageAttachmentIds | B02 原私有图片链接、最多 8 张 | 当前选定保存快照的全部图片 | 原 intent → transfer → finalize、原限额、原服务端读取权限 |
| version/status/canEdit/canSubmitSourcing/sourcingCaseId/initialVersion | B01 状态和原动作；旧深链保留 | 当前选定保存版本 | 原服务事实；原外发条件、母单和版本参数 |

没有增加利润率、通用备注、更多或批量操作。预算主单数据与屏幕视图仍为同一组件状态；打印只绑定当前选定的保存快照，沿用原纸单 DOM 结构、方向、全字段及全部行。dirty、busy、无保存快照时不输出旧纸单。

## 填写与显示

- 可用内容宽 A≥1120 时右栏 320px，间隔 16px；更窄时同一组件单列。图片每个容器 140×140，字段网格 min160/间隔12，真实内容可增长。
- 只有单据工具栏 sticky；成本区仅在其实际高度可装入视口时 sticky。手机输入 16px、操作至少 44px；表格自行横滑，第一识别列固定，页面不横向溢出。
- 原手动保存和发布分别执行；请求期间原 busy 锁输入、防重复。错误不清空输入，409 不静默重试，明确确认重载才丢弃本地修改。
- 复用平台已有的单据离开守卫，覆盖侧栏站内路由、查询深链、浏览器返回和页面卸载；dirty 取消离开保留输入，busy 不离开。预算自身返回使用原父层导航入口，不重复弹确认。
- 已知模板且只有预置类别的未编辑空行可收起；supplier/specification/字符串 0 都保留。无法证明是模板的持久化行显示。视图切换不改变 payload；加行先激活同组空模板，所有原行 ID 完整保存；300 行上限保持。
- 数值保留字符串缓冲；无效输入保留并标记预览不可用。调用原 Schema/publishErrors/calculateBudget/budgetDisplayAmount，不新增必填项或公式。
- Tab/Shift+Tab 原生顺序；Enter 同列下一可见行，最后一行不提交；Esc 恢复当前格进入时值；IME 选字不跳格；textarea 原生换行。错误目标为稳定 rowId，删除其它行不改变目标。
- 上传部分成功后保留成功项；原批次重试不重复已成功关联项；未 finalize 不算成功。不持久化预算、签名 URL 或草稿缓存。

## 已批准的已发布预算边界

业务负责人于 2026-10-06 14:29:33 UTC 明确同意：已发布版本始终只读；原授权岗位点击明确的“另存为新草稿”并确认后才能修改，新草稿再单独发布。保留原 `DigitalBudgetService.read().canEdit` 与 P09 的授权能力，不扩权、不修改历史版本。

该动作仅在原 canEdit 为真且正在查看当前已发布预算时出现；历史查看、原无写岗位、已进入外发的锁定预算不出现。确认后使用原完整文档 PUT/expectedVersion/幂等键保存副本为新草稿，成功后才显示编辑控件；取消或失败保持已发布只读。草稿修改仍需手动保存，再单独发布；没有增加服务命令、审批或新文档实体。

## 验证记录方式

正式组件固定 B-F01 合成场景形成工程基准，然后解除 GET 固定场景，读取同一订单原 API，再比较同浏览器、字体、DPR1、1448×1086 的真实像素。其它实测尺寸为 1366×768、1920×1080、390×844，均实际输入和保存。B-F02 验证内部 44.399/3.601 与显示 44.40/3.60；另测空、0、负利润、非法文本、6/7 位小数、300 行、8 张图片、普通设计师/跟单/技术岗位正反权限、保存重试、版本冲突、历史和原外发深链。旧成熟模块六处的内部文字、控件及计算样式与基线比较。

全部业务写入只针对本机明确归属 TEST 订单和隔离数据库。上传使用原服务与原 AcceptanceObjectStorage，仅本地 scratch 入口将对象目录定向到本任务可写 TEST 目录；仓库 server、线上对象与部署配置未改。最终 PR 记录准确 intended Head、本地检查、Full Gate、一次 Codex Review 及合并 SHA；原型截图不替代最终 Head 证据。真实手机键盘、物理打印机和线上 UAT 未运行，不写通过。
