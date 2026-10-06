# DOC03 大货制单字段与交互

按《三大单据 UI 与填写交互施工规范》正文增量重排正式 ProductionInstructionPanel；六页签共享一份 InstructionDocument。无 Schema、服务端、权限、迁移、数量账或审批规则变更。

| 原事实/字段 | 屏幕区域 | 原纸单区域 |
|---|---|---|
| order customerCode/designStyleNo/lines；lineId、PO、正式/代用号、color/colorForeign、sizes[].quantity | 只读摘要、生产主单数量矩阵；按 lineId 对应 | 六页抬头及生产主单数量矩阵 |
| styleName/category/season/fabricType/composition/process/patternMaker/date/secondaryCraft | 生产要求，长文本保留5000字；印绣路线仍原枚举 | 六页抬头 |
| preshrink/shipSample/sewingRequirements/comments | 主单原要求、预缩、船样与评语，各一个输入 | 生产主单，原四条车缝文字、船样提前10天、加裁5%条款 |
| remarks | 共用右栏唯一备注输入 | 原六页抬头备注 |
| fabrics[].id/name/part/colors/remarks | 面料页；colors 严格用母单 lineId；200行 | 面料单原顺序、全部颜色与备注 |
| accessories[].id/group/garmentColors/materialColor/name/category/part/specification/consumption/remarks | 车缝、包装页分别筛选同一数组，合计400行；原默认成衣颜色 | 两张原辅料单；包装保留48小时清点条款 |
| images[].attachmentId/kind/description | 工艺图文；8种原分类、60图片、原大小接口、5000字说明；右栏只读链接 | 全部工艺图文，不受当前页签影响 |
| unit/sizes/measurements[].id/name/tolerance/method/values | 尺寸表；50尺码、200部位；分数保持字符串，不新增放码/改尺码列动作 | 原每8码分组尺寸表，完整公差、量法和所有值 |
| version/publishedVersion/versions/isPublishedSnapshot/sourceRound/latestSourceRound | 原版本选择及开发来源轮次分开；URL指定版本直接读取；历史只读 | 当前选择的已发布保存快照、原打印人及北京时间页脚 |
| dateRequests/canApproveDate/currentDeliveryDate/currentOrderVersion | 原交期申请、理由、批准/驳回和历史；不直接改母单 | 原选定快照中的合同交期 |

保存仍为原 PUT 完整 document + expectedVersion + orderVersion；1200ms 单一定时器、单写请求和 generation 保护。仅保存请求期间允许继续输入，旧回包只更新已确认版本，不覆盖新缓冲。冲突/请求失败暂停自动重试，保留输入；显式保存或确认重载后恢复。切页签不改变 dirty、版本或 payload。切版本、离开与重载保留在写保护及确认。

复用三单据限定 DocumentField。DOC03 额外传入保存值及保存版本，使 Esc 只撤销当前未保存格，不倒退已自动保存的值；预算和开发未传入新参数，原行为不变。发布校验只来自原 InstructionDocumentSchema 与 instructionErrors，摘要先打开相应页签，再定位稳定行 id 的字段；空可选页不新增必填规则。

打印抽出原纸单视图，仅绑定 sheet.document 的已发布快照；A4横向、原抬头/分组/条款/页脚保持。未保存、处理中或草稿不能以旧值打印。屏幕和打印没有两份业务状态。

允许文件仅本页组件/样式/验证与打印视图、限定公共输入的保存检查点、定向测试及本文档。禁止修改全站 Shell、旧成熟模块、后端、依赖、部署和在线数据。工程级别 FULL；正式门禁使用当前 HEAD 的 FULL CI；业务负责人于2026-10-06明确要求 DOC03 跳过 Codex Review。
