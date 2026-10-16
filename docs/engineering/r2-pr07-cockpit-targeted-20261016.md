# V2.0 R2-PR07 — 座舱与订单档案局部修复

## 预检与边界

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1（本轮明确授权）
- base SHA: 113569e150b1f92b6bb30e970c5164d7f6e65ed5，包含 PR06 #774；main 只读核验为 8c2beb55925c15d93e37e7cfaa42b635426a455b。
- working branch: feat/r2-pr07-cockpit-targeted
- Gate: FULL，最终 intended Head 成功后一次必要 Codex Review。
- 依据：用户批准的 V2.0 PR07 完整允许清单、C01—C08、[C4]、AGENTS.md；施工文档 SHA256 7a39adb98dc181e54536e0448f700be60c43223a4f3a2ce6d167adebb349e15b。
- 允许：座舱 TSX/model/局部 CSS、订单档案与列表局部 CSS、共享壳中数字生产原生详情的重复返回分支、必要测试/规则文档。
- 禁止：API/权限/统计聚合/工资/历史数据/部署/基础设施/无关布局/PR08 看板施工。无 migration。

## 允许项覆盖

| PR07项 | 实现与保留 |
|---|---|
| 1 重复产前块 | 只删末尾 journey-preparation-reference 及专用 CSS；原七阶段、产前节点、记录、风险保留。 |
| 2 日期文案 | 档案复用 customerPoDateLabel=出货日期；PoDateSummary/Details/OrderFacts 已复用同常量，未重复修改。工厂日、船样目标、存储字段不变。 |
| 3 当前任务 | 独立命中原因列并入当前任务/等待原因；按 instanceId 去重，负责人、具体阻断与日期风险仍在。KPI 查询不变。 |
| 4 默认阶段 | 精确 focus、显式阶段/历史轮次优先；缺省选真实 active/blocked，再真实 pending 记录，再适用完成阶段；未启动占位不抢活动任务焦点。并行任务及其他阶段可切换。 |
| 5 适用节点 | 默认范围过滤 not_applicable，保留 uncreated/pending/cancelled/inherited；精确历史定位可查看不适用事实；全部阶段可主动查看。 |
| 6 统计 | 只变显示范围；原 progress 与 KPI 未改。全单进度和当前显示节点范围分别标注。 |
| 7 资料 | 原相关单据区增加本单资料入口，既有开发/制单/预算具体版本继续使用 PR04 同容器路由；不改资料权限。其他原记录不被错误重定向。 |
| 8 返回 | 原生数字生产详情已有返回时共享壳不再叠加返回链接；有效阶段/节点写入下钻返回上下文，筛选/页码/轮次保留；左导航未改。 |
| 9 档案 | 原单一紧凑只读资料、逐PO数量/日期、版本及采用轮次保留；详情文案指向已有本单资料入口。 |
| 10 空框/列表 | PR06 已消除无选择空框，未重复施工；本次解除列表270px固定高度，分页在完整当前页之后。 |

## 验证证据

- 定向单元24项：活动/真实阻断、并行、显式阶段、历史focus/row/round、多阶段返回、不适用/未启动/沿用、结束阶段、全单progress不变、资料入口、无订单/三PO/权限读取失败。
- 默认测试：2354通过、561条件跳过，455个测试文件通过。
- 隔离 PostgreSQL Journey 16项通过：原权限、风险、汇总与快照读路径保持；资料权限浏览器用真实服务验证普通工人预算拒绝且无预算请求。
- 真实本地服务浏览器41项检查、errors=[]，复用PR03—PR06原测试；新增阶段显示、全阶段切换进度不变、历史任务→资料→唯一返回、相关单据目录、总览合并列。
- 同一份合成订单快照对比 PR06 代码与候选代码：1440×900、1600×900、1165×757 三视口，原七个受保护面板的 x/y/width/height/background/border/font/fontSize 全部相同。不是用参考图重画页面。
- 本地截图/录屏/几何/快照：/workspace/r2-pr07-evidence/final；pr07-baseline-comparison.json、pr07-geometry.json、result.json、pr07-*.png。命令日志 /tmp/r2-pr07-*.log。
- 类型/lint/build（含静态链路检查）、migration lint、secret scan、diff检查；最终 Head Gate/Review/merge 以PR实时证据与交接记录为准。

## 未测边界

未部署、未访问生产/Acceptance实单、真实OSS、钉钉或生产服务；没有移动端视觉验收。浏览器使用隔离测试库和本地对象存储，PR06品类报价为既有明确UI夹具。三PO独立日期/数量是SSR测试，浏览器座舱为两PO真实测试服务记录；不声称完整业务人工验收。网络策略拒绝FFmpeg CDN下载后停止下载，改用环境已有/usr/bin/ffmpeg录屏，不改网络规则。
