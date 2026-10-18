# 全系统实收标签范围核对

用户已确认最终字号规则：min(原标签字号, max(10px, 原标签字号-3px))。原标签/数字不放大或缩小；手机原9px处提示同9px，浅色和正常字重区分。本清单对应当前PR完整范围；最终Head及Gate在PR交付中记录。

共6组件18处；当前main可达14处，未挂载回货分析4处。后者同口径已同步代码，但不计实际可访问页面覆盖。

## 完整清单

|ID|位置|路由|值字段|最终实测px|源码|
|---|---|---|---|---|---|
|F01|仓库收货录入/补录|/ui/receiving|`actualQuantity`|14→11|[receiving-page.tsx:628](../../apps/web/src/receiving-page.tsx#L628)|
|F02|嘉顺/其他工厂多次收货|/ui/receiving|`actualQuantity`|14→11|[receiving-page.tsx:550](../../apps/web/src/receiving-page.tsx#L550)|
|F03|多次收货成功反馈|/ui/receiving|`receipt.actualQuantity`|14→11|[receiving-page.tsx:336](../../apps/web/src/receiving-page.tsx#L336)|
|O01|期间/搜索结果实收KPI|/ui/orders|`kpis.receivedQuantity`|12→10|[order-board-page.tsx:739](../../apps/web/src/order-board-page.tsx#L739)|
|O02|列表实收总量|/ui/orders|`row.cumulativeActualQuantity`|桌面10→10；手机9→9|[order-board-page.tsx:813](../../apps/web/src/order-board-page.tsx#L813)|
|O03|逐次历史：本次实收|/ui/orders|`item.actualQuantity`|11→10|[order-board-page.tsx:858](../../apps/web/src/order-board-page.tsx#L858)|
|O04|逐次历史：累计实收|/ui/orders|`item.cumulativeActualQuantity`|11→10|[order-board-page.tsx:859](../../apps/web/src/order-board-page.tsx#L859)|
|O05|收货/装箱差异快照的实收|/ui/orders|`differenceEditing.row.cumulativeActualQuantity`|12→10|[order-board-page.tsx:930](../../apps/web/src/order-board-page.tsx#L930)|
|O06|修正本次收货|/ui/orders|`receiptActualQuantity`|14→11|[order-board-page.tsx:985](../../apps/web/src/order-board-page.tsx#L985)|
|O07|修改收货订单|/ui/orders|`editActualQuantity`|14→11|[order-board-page.tsx:1005](../../apps/web/src/order-board-page.tsx#L1005)|
|R01|返工来源收货摘要|/ui/tasks/:id|`detail.sourceReceivingActualQuantity`|12→10|[rework-detail-page.tsx:755](../../apps/web/src/rework-detail-page.tsx#L755)|
|P01|生产单关联回货记录|/ui/production-dashboard/:id|`r.actualQuantity`|14→11|[production-closure-ui.tsx:51](../../apps/web/src/production-closure-ui.tsx#L51)|
|S01|供应商履约：有效累计实收|/ui/suppliers；/ui/suppliers/manage|`item.receivedQuantity`|13→10|[production-analysis-panel.tsx:52](../../apps/web/src/production-analysis-panel.tsx#L52)|
|S02|供应商履约：逐次关联实收|/ui/suppliers；/ui/suppliers/manage|`receipt.actualQuantity`|13→10|[production-analysis-panel.tsx:52](../../apps/web/src/production-analysis-panel.tsx#L52)|
|U01|未接入回货分析：累计汇总|无当前页面引用/路由|`data.summary.actualQuantity`|13→10|[receiving-analysis-panel.tsx:56](../../apps/web/src/receiving-analysis-panel.tsx#L56)|
|U02|未接入回货分析：送货→实收→装箱|无当前页面引用/路由|`item.actualQuantity`|13→10|[receiving-analysis-panel.tsx:64](../../apps/web/src/receiving-analysis-panel.tsx#L64)|
|U03|未接入回货分析：单据历史/修正值|无当前页面引用/路由|`receipt.actualQuantity`|13→10|[receiving-analysis-panel.tsx:67](../../apps/web/src/receiving-analysis-panel.tsx#L67)|
|U04|未接入回货分析：处理当时快照|无当前页面引用/路由|`resolution.actualQuantity`|13→10|[receiving-analysis-panel.tsx:69](../../apps/web/src/receiving-analysis-panel.tsx#L69)|

## 不适用及保持原样

|项|理由|定位|
|---|---|---|
|送货单、实裁、装箱、生产量/发货量|不同业务事实，非实收总量。|order-board-page；production-analysis-panel；production-closure-ui|
|次品独立量、返工件数、工资/工序实际报数|不良子集或劳动产出，不是实收。|receiving-page；rework-detail-page；work-reporting-form；wages/wage-period-detail|
|无有效实收订单数、收货条数、首次到仓/实收日期|单位为单/次/日期，不是收货件数。|production-analysis-panel；production-exclusion-controls|
|审计诊断actualQuantity修订次数|只显示字段名和修订次数，不显示实收字段值。|work-analysis-panel；operation-diagnostics|
|必要说明、校验错误、普通收货成功后的次品数/差异|不是实收数值标签；保留已有必要反馈。|receiving-page；production-analysis-model|
|样衣归还、小票、出售回款、打板接收、静态演示导航|不同对象或金额，或仅导航文案。|sample-*；pattern-room-orders-page；production-command-center-view|
|导出、请求、权限、存储、统计及计算|按授权保持原样；未改导出结构和表头。|apps/api；packages/contracts|

## 数据流证据

- 仓库/订单回货：`apps/api/src/receiving/receiving-service.ts:423-448,2760-2785`；actual与defective独立求和；actual包含次品；历史采用修正值或原值。
- 返工摘要：`apps/api/src/rework/rework-business-detail-service.ts:253；receiving-quantity-ceiling.ts:17`；关联批次sum(actual_quantity)+adjustment，未减次品。
- 生产回货记录：`apps/api/src/sourcing/production-closure-service.ts:140`；取修正actual或原receipt.actual；归档另标。
- 供应商累计实收：`apps/api/src/sourcing/production-analysis.ts:85`；对有效关联实收求和，不减次品；归档/排除单独处理。
- 未接入回货分析：`apps/api/src/receiving/receiving-analysis.ts:61,80,88,113`；累计、逐次修正实收及不可变actual_quantity_snapshot均含次品。

## 字号和证据边界

最终已确认并实现：14→11（录入/编辑/修正/生产回货等）、13→10（分析）、12→10（KPI/差异快照/返工摘要）、11→10（历史）、列表桌面10→10/手机9→9。原字号不改，沿用已有收货提示浅灰#70757e和正常400字重。单纯max10规则已废止；严格减3导致6–8px的旧候选不作为最终方案。

本地实际应用路径覆盖：24录入组合、6编辑宽度及取消/模拟保存、16列表/历史/差异/逐次修正/搜索视图、2多次收货成功反馈。另6组真实源组件隔离渲染覆盖生产回货、供应商履约、未接入回货分析及返工摘要；不冒称完整岗位业务验收。全部为合成样本、接口在浏览器或夹具内拦截，无生产数据库/业务后端操作。

≤380px仅将逐次修正的长标签实收字段占整行；历史实收允许换行且数字与单位保持成组，避免标签越界和数值截断，未改请求。

最终Head、适用Gate和截图由PR #802的交付记录对应，不用旧Head证据替代。
