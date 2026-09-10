# B方案 PR05：回货分析并入原筛选

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 8d510c5d913601c5e2b11d71cddab39967604c23（PR04 #459 已合并，Full Gate 34466616260 成功）
- working branch: work/b-plan-pr05-receiving-filters
- scope: 去除独立分析框，原列表按差异、未记录、待处理、已有处理、旧处理待复核筛选。
- allowed: receiving board 只读查询/类型、原筛选区与行内异常提示、对应局部样式、测试及文档。
- forbidden: 原卡片字段结构、收货/装箱/修正/处理写入逻辑、权限、全局CSS、损耗归责猜测。
- gate class: FULL。

复用已有处理快照匹配；当前差异非零且无匹配处理才计待处理。旧处理无当前匹配时显示待复核并可回看旧结果与图片。装箱缺失保持 null，只对有实收的订单提示未记录。汇总和原列表使用同一筛选集，在分页前汇总；导出沿用原权限和当前筛选。按用户实用优先要求进行正常路径及旧处理失效的定向回归，不追加可选 Review。

## 验证

API/web TypeScript、定向 ESLint 通过；原分页/权限/差异合同 16 项通过。PGlite 定向 8 项通过，覆盖原分析SQL、原装箱及差异写入链、待处理→已有处理→追加收货后待复核、装箱缺失保持 null。旧结果与凭证保留；本 PR 不改写入逻辑。最终视觉验收留部署后。

Gate 首轮发现旧静态测试仍在原服务内查找已抽出的筛选SQL；更新测试读取共享筛选片段，保留多次收货与全时间搜索断言。业务SQL无需调整。
