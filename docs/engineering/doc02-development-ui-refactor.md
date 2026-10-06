# DOC02 开发单 UI 与填写交互

授权集成基线为 PR662 已合并的 release `444a52d7815487265bfa22d6490cdb7862c27986`；main 只作事实核对，不合入不同迁移历史。依据留存的《三大单据UI与填写交互施工规范 V1.0》正文与已列图片例外。只修改开发单正式组件、页面作用域 CSS、原契约错误定位及定向验证；复用 DOC01 有限公共组件，不改外壳、其它成熟模块、后端、Schema、迁移、部署工具或业务默认值。

| 原键 | 屏幕区域 | 原打印位置 |
| --- | --- | --- |
| sourceId/designStyleNo/temporaryStyleNo/customerCode/designerName/developmentType/version/roundNumber/latestRoundNumber/canEdit/canRevise | 原身份/轮次摘要、工具栏、办理区；sourceId 用作原关联，无自由输入 | 原纸单身份、轮次及资料版本 |
| template/quantity/sampleSize/orderDate/returnDate/craft/washing | D05 基础资料两列 | 原纸单摘要、工艺与洗水 |
| instructions | D04 唯一制作说明 | 原制作说明 |
| materialId/category/label/supplier/name/specification/consumption/quantity/requiredThisRound/available/expectedDate | D06 分类技术表及原稳定 materialId | 原逐材料表及物料事件 |
| width/weight/composition/color | D06 每行可展开技术详情 | 原逐材料表 |
| unit/sizes/measurements.name/measurements.values | D07 尺寸矩阵；仅 UI 本地稳定行ID，不增加业务键 | 原按4尺码分组矩阵 |
| interlining/placketInterlining/sewingThread/buttonholeThread/stitchDensity | D08 朴料、车缝分组 | 原工艺键值表 |
| washingIroning/packaging/formalSizes/casualSizes/mainLabel/mainLabelMethod/sizeLabel/careLabel | D08 洗水包装、尺码标识、唛类，关闭开关不抹车法 | 原工艺键值表 |
| files[].attachmentId/kind | D04 款图/局部图与原分类附件区，最多30 | 原图片及菲林/工艺开发板链接 |
| revision 全部原依据键、materialEvents、岗位办理 | 原 round-draft/round-publish、物料事件与 DevelopmentExecutionPanel | 当前选定保存快照和原物料记录 |

可用宽度≥1120时左右60%/40%、间距16；窄屏单列、表格自身横滑，材料首识别列与尺寸项目固定。款图/说明约50%/50%，主图240—340、缩略图64。原技术字符串不转数字、不读预算API、不新增价格/金额/公差/量法/示意工厂。数量保留原整数契约并先校验原始编辑缓冲，非法输入不静默写成null。

原始开发仍手动 PUT expectedVersion/full document；原复版仍 PUT expectedDraftVersion/full revision及单独 round-publish；原物料事件仍携带 expectedMaterialRevision+expectedVersion。写请求 busy 防编辑/重复，原站内导航守卫、幂等键、服务端错误/冲突保留输入与确认重载。发布可点击定位原发布规则；dirty时不发布旧草稿。锚点不卸载、不重新取单。原角色合法办理、历史只读、最终设计确认和工资衔接不改。

保留原 DevelopmentPrint 的DOM、字段、图片和方向，只绑定选定保存快照；复版保存成功后取原rounds草稿的服务端规范化文档。dirty/busy时输出不可打印提示，防系统打印快捷键把旧值当最新。原附件intent→transfer→finalize；分类/格式/原大小限制，部分失败仅内存记录成功指纹，重试不重复关联，无localStorage或物理删除。

验收证据另存于本任务 materials/doc02，分别记录原型与最终clean Head：固定正式组件→同数据原API、四尺寸真实输入与完整字段往返、原打印、键盘/IME/模板/最大矩阵/附件、普通授权及拒绝、轮次与物料事件/岗位/工资回归、六成熟模块。FULL与唯一GitHub Codex Review均在最终组装后执行。不是部署或线上UAT证明。
