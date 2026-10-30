# PR3：板房复版业务时间与跨轮历史附件

## 预检与边界

- Repository：`lizhonghao31-crypto/dx-rework`。
- 实际远端基线：`release/digital-production-v1@904978d66ccce179ce14c32d54dcf48fabda6862`；tree `3293f9654cecd08def820a11316aa4639c79a626`。
- 分支：`fix/acceptance-rework-round-time-attachments-pr3-20261030`。
- main只读核为 `67841e105fe7090e219477171d3cf79565719241`；独立正式代报热修不混入、不重排迁移。
- FULL：涉及业务发生时刻、原生/数字开发衔接及授权后的历史投影。本阶段只完成本地验证与完整diff，等待推前独立检查；不提交、不推送、无PR/CI。
- 允许：3个业务文件、精确时间候选索引、必要原生PG/单元/真实组件夹具及本文。
- 禁止：物流PR4、PM2、正式临时报数、角色/权限、迁移/checksum、现场数据库/旧订单、部署与main写入。
- 规则：AGENTS V2.1；`pattern-room-finance-v1.0.md` §6要求独立轮次、原工资/数量/用时保留；`digital-sla-golden-source-20261023.md` 要求可信实际起止、1天=24小时、不以登记/创建代替；`acceptance-sla-clock-20261026.md` 明确业务时间与真实审计时间分离，附件按真实登记截止授权。未发现仓库相关`.agents/skills`。

## 逐入口与消费者

| 链 | 已核源码与最小责任 |
| --- | --- |
| 设计师复版保存/发布 | `DevelopmentRoundService.publish`在原事务、advisory lock、草稿版本与幂等回执内进入`publishWithClient`。只显式写新行的业务`published_at`；原授权、源轮版本与生命周期不变。 |
| 原生板房返工 | `PatternRoomOrderService.requestRework`先验证原单/当前轮/开裁边界，建立新原生轮与附件，再同事务调用`publishWithClient(...patternReworkRoundId)`。新发布时间不再落SQL墙钟；原角色、核价、派工、原生计薪与数量规则不动。 |
| 尾查内部退回 | `DevelopmentExecutionService.route`同样调用`publishWithClient(...returnTaskId)`；保留原尾查授权、受影响工序与原始首次下单日期保护。公共插入点统一取可信`businessNow`，不改路径或另起时间引擎。 |
| 发布→任务/截止 | 新轮`published_at`继续由原`developmentDocumentRow`、`DevelopmentRouteService.startRound`及任务/SLA投影消费。冻结时间的真实接收、派工及前置均发生在同一业务秒，车板24小时从原实际进入锚点推导。无证据起点继续null/缺失，不为通过测试填入当前时间。 |
| 附件→历史节点 | `PatternOrderReader.get`在原授权和repeatable-read只读事务中查询原绑定/审计，再按`roundId→attachmentId`保存每个绑定的微秒审计时间。旧的全局attachmentId键会被后来继承绑定覆盖，误丢旧轮文件。 |
| 历史截断→原页面 | `patternOrderAtNode`仍要求唯一终结事件、可信审计顺序和场景版本，仍按真实终结审计截止及该轮事件里的附件ID过滤；只将绑定时间查找改为轮次内身份。缺归属/绑定证据标记unknown，不借当前轮或当前资料回填；保留能证明的字段，所有历史办理动作仍关闭。 |

审计`created_at`、绑定`bound_at`、工资释放审计、认证/session/TTL均保留真实时间。原已应用迁移、trigger和历史行无改写。生产读取始终提供按轮绑定map；提供map但缺该绑定时不退回`addedAt`。未提供精细map的纯投影沿用该附件原绑定`addedAt`，不取场景now或当前资料。

## 明确红测与失败记录

- 业务代码未改前，原历史单元19项通过，新增微秒截断和缺归属unknown两项失败。
- PG16基线8项失败：3种场景的新复版`published_at`为真实墙钟；4种时间域中，三轮完成后原轮资料被误投影为0份。第8项是测试错误要求所有ready任务都有已知起点，不能计作新增业务缺陷。
- 第一轮绿测PG16为5/8、PG13为1/8：仍有3项把合法未知起点强制当作已知；PG13另4项的测试快照SQL使用无AS的`value`别名，不兼容13。依据冻结规则保留null/缺失，改为在有真实前置的关联原生链严格断言进入时刻/24小时；SQL明确`AS snapshot`。不改业务守卫、阈值或旧断言的金额/数量口径。
- 首次额外并发快照查询误用了不存在的`recorded_at`；改为按已有主键`revision_id`稳定排序，保留全部原行列快照和时钟推进后不变断言，仅复验该2项。旧失败日志保留。
- 执行驱动曾在进入测试前因缺少`NODE_ENV=test`被安全守卫拒绝，另一次版本诊断SQL别名错误；均未运行目标用例，不计业务失败或通过。随后使用原受支持配置，未关闭安全检查。

## 实际本地验证

Node **22.22.2** / npm **10.9.9**；隔离PG **13.23** / **16.15**，原测试marker检查通过，使用既有隔离测试角色。每个fixture应用完整当前278项迁移，原SQL守卫启用，最终调用原dispose清理自有随机schema。无ECS/生产连接。

| 实际命令/选择 | 结果与证据 |
| --- | --- |
| `vitest run tests/integration/development-round-history-clock-postgres.test.ts tests/integration/native-rework-round-clock-postgres.test.ts --config vitest.business-chain.config.ts --fileParallelism=false --maxWorkers=1`；分别注入本地PG13/16 URL及`NODE_ENV=test` | 各12/12通过。原轮+连续两返工轮；过去/当前/未来冻结秒及普通真实时间；显式publication、真实审计、实际车板起点/24h；按轮继承1/2/3份资料；原生非法工序与无权角色失败的原子回滚；原工资与原资料数量不变。`pg13-matrix.log` / `pg16-matrix.log`。 |
| 同配置，仅该原生复版文件 `-t 'concurrent publication'` | 各2/2通过，其余8项为名称过滤未选，不是未覆盖。相同key两个请求均返回且只插入一轮，不同key/同草稿版本只有一个成功；后来推进独立测试时钟再重试原key，原任务及deadline revisions全部现有行列快照不变。`pg*-concurrency-fixed.log`。 |
| 同配置 `tests/integration/time-reading-clock-postgres.test.ts` | 各13/13通过；原逐单时钟、历史终结/附件、混场景读取、错误隔离与精确截止回归。`pg*-existing-reading.log`。每个PG版本合计27个不同目标用例，分批执行，非冒称一次27项全绿。 |
| `vitest run tests/unit` | 487文件 **2588/2588通过**，含新增3项历史附件证据用例及既有终结身份、同业务秒/微秒/同审计时刻歧义、缺终结、worker/finance字段隔离、工资与原轮次逻辑。`all-unit.log`。 |
| `PR3_HISTORY_UI_INPUT=<PG16导出文件> node tests/acceptance/rework-round-history-browser.mjs` | **26场景通过**：12个实际PG历史DTO在1440/390触摸模拟视口逐轮显示准确附件ID与1/2/3份，全部只读；另2个明确合成unknown提示。页面errors为空。`browser.log`、`browser/results.json`。 |
| `npm run typecheck`、`npm run lint`、`npm run build --workspaces --if-present --ignore-scripts` | 全部通过。API tsc、共享包与web Vite实际构建；未跑root postbuild业务链或把构建冒充远端Gate。新增并发测试最后一次SQL修正后另对该文件eslint通过，未重复整套。 |

原native fixture只增加可选路线选择与返回创建ID，默认仍跑原4路线、原断言全部保留。本轮每个时间域只选择无工艺/免洗，复用真实首次制作流程，避免重复无关路线。旧独立打板历史另沿原私有历史测试assembler构造，未重新开放被关闭的公共新建入口；新关联开发链通过正常发布/派工/接收/车板/尾查/设计确认/原生返工办理。

## 证据边界与交审

- 三个业务文件为唯一生产逻辑变化；精确时间索引仅更新`development-round-service.ts`这一行的候选，从1处到3处，扫描器/其它文件/忽略规则未改。
- 原生返工invalid工序在新轮/附件已进入原事务后被拒，比较原单、轮次、绑定、数字复版、任务、事件和附件元数据快照不变；权限403与同/不同key409均真实断言，不手工拼成功回执。
- 实际PG测试证明本地真实迁移/服务/权限/事务，不代表现场旧坏样本已修正或复验。场景推进只用于新建的隔离fixture并发重试验证，不推进现场时钟。
- UI使用实际产品React组件及PG导出DTO，但HTTP、unknown投影与缩略图字节为本地夹具；不是实际OSS下载/现场登录或完整视觉验收。移动仅Chromium触摸模拟，未实测实体iOS/Android。
- 无迁移、数据修复、权限扩张；历史工资、已完成评价、冻结标准、原数量不重置。现有pg客户端并行query弃用警告仍保留，未升级依赖或改变阈值。
- 本地完成后交完整diff供独立审查；当前无提交、推送、PR、GitHub Review或CI。后续遵循轻检查→GitHub Codex Review→集中修复→唯一最终Full/Final精确Head；不提前PR4。
