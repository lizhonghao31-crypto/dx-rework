# PR2：客户下单日期与发厂时间输入

- Repository: `lizhonghao31-crypto/dx-rework`
- Base: `release/digital-production-v1@046143ff8108757858b8c76b08372d71899a0f9c`；main只读核为 `67841e105fe7090e219477171d3cf79565719241`。
- Branch: `fix/acceptance-order-date-dispatch-time-pr2-20261029`
- Gate: FULL（核心办理、日期/时间校验与幂等）。本阶段只交本地 diff 和证据，等待推前独立审查，不推送。
- 允许范围：原日期 options 服务/表单、发厂输入及服务端取时、必要契约与测试、逐项时间清单。
- 排除：复版/跨轮附件（PR3）、物流范围（PR4）、PM2/部署、独立正式返工、迁移/checksum、权限/原时间上下界、旧现场事实。

## 定位与契约

| 入口/消费者 | 基线事实与本次实现责任 |
| --- | --- |
| `IdentityService.createOrder`（含来源确认）与 `DevelopmentService.publish` | 已使用验证过的 `businessNow` 校验客户下单日期；不改变其真实订单、来源绑定、发布、数量与权限规则。 |
| `GET /digital-production/options` | 原固定 `new Date()`；新增可选来源ID，先校验原来源可见权限，再按该来源的可信 BusinessClock 读取日期；无来源的全局新建仍按真实北京时间。原 clock hook 已解析 query.sourceId 并拒绝混场景/混普通单，无新增任意场景参数。 |
| 开发直接新建、已有来源确认、草稿恢复 | 同一表单的默认值、max、PO日期下界与提交前预检必须使用同一可信归属。来源日期读取前保留资料并阻止确认，读取失败不得退回全局墙钟。刷新/跨日只更新日期边界，不清空已填资料或重启未知提交。 |
| 分批发厂与旧整款发厂 | 共用“本单当前时间/手工时间”输入；当前方式省略 occurredAt，后端在原命令事务执行时取一次 businessNow；手工支持秒/毫秒和北京时间显式转换。 |
| `FactoryDispatchSchema` / `FactoryFlowService.dispatch` | 只增加缺省时间语义，显式 null 仍拒绝；实际时间在原幂等回执执行块内解析，hash保留原请求，重试不重新生成事实时间。两条办理分支使用同一已解析时刻，原下界/当前上界、角色、QC、实裁、数量、版本守卫不放宽。 |
| 旧整款回归 | 复用原有历史夹具的受支持路径；该既有测试在构造旧准备版本时临时关闭一张夹具表的 USER trigger，实际发厂前已恢复。此PR不新增这种构造、不关闭运行守卫，也不把它冒称全部历史迁移已原生复现。 |

## 本地矩阵

Node22.22.2 / npm10.9.9，共享包构建通过。隔离PG13.23和16.15实际版本及低权限数据库marker均已验证；只创建/清理自有随机schema。

- 日期：过去/当前/未来/普通来源；客户当日等号允许、次日拒绝；北京时间日终±1ms；全局与其它来源/场景隔离、来源权限、非法ID；原正式确认与同key回执。
- 发厂：缺省时刻、手工秒/毫秒；下界-1ms/等号/+1ms及当前上界；失败回滚、同key重试；普通订单真实时间；分批与旧整款输入；保留旧精度与实绩。
- UI：桌面与移动视口，实际组件的时间选择/提交、来源日期默认/max及刷新、已填和已发布订购资料不被清空；UI模拟响应只证明前端行为，不替代原生PG权限与时钟证明。
- 基线首次红测12项中2通过/10失败：4项为日期读钟及来源预检差异；6项因测试路由误写，不能算业务失败。更正原路由后单独复验发厂子集，保留两轮日志，不降低断言。
- 首轮发厂红测还曾遗漏真实路由所需的附件依赖；更正为原 `/factory-flow` 及完整路由依赖后，缺省时间在基线确实被400拒绝。修改后第一轮11/12通过，剩余一项误把既有不可见来源404写成403；按原权限策略纠正断言，未改变生产权限。

## 实现文件与必要性

| 文件 | 本次必要变化 |
| --- | --- |
| `identity-service.ts` | 原来源可见权限通过后读取该来源BusinessClock；全局无来源options保持真实日期。 |
| `identity-routes.ts` | options严格解析可选sourceId，统一服务日期结果；沿用原场景hook。 |
| `digital-development-create-form.tsx` | 来源默认/max、恢复与提交预检一致；刷新失败保留输入且不回退墙钟，已发布资料不覆写。 |
| `factory-dispatch-time-input.tsx`（新增） | 两入口共用当前/手工输入；当前不发客户端时间，手工支持毫秒和明确北京时间。 |
| `factory-batch-panel.tsx`、`factory-flow-panel.tsx` | 仅将两条仓库发厂表单接到上述控件，不改物流、QC等其它表单。 |
| `contracts/factory-flow.ts` | occurredAt可省略，显式null/非法时间仍拒绝。 |
| `factory-flow-service.ts` | 原幂等执行块内一次解析缺省businessNow，旧整款/分批共享；原请求hash与所有下上界不变。 |
| 时间清单JSON | 只刷新4个已改源文件的候选指纹，不改变扫描规则、忽略项或其它文件条目。 |
| 新PG/单元/浏览器/React夹具（4文件） | 直接覆盖可信来源日期、边界、幂等/并发、权限/场景、实际输入交互。 |
| `sourcing-pr03-postgres.test.ts` | 原旧整款用例改为缺省时间，保留原断言并增加实际时刻/重试单事实断言。 |
| `factory-batch-ui-browser.mjs` | 原手工输入先选择新模式；明确生产JSX编译，原断言及超时不变。 |
| 本文 | 固定范围、实际证据和未验证边界。 |

## 本地最终结果（2026-10-29，未推送）

以下命令使用Node22.22.2 / npm10.9.9；数据库连接只通过本地私有环境变量注入，未写入文档或补丁。

| 实际检查 | 结果 | 范围/证据 |
| --- | --- | --- |
| `vitest run tests/integration/order-date-dispatch-time-postgres.test.ts --config vitest.business-chain.config.ts --fileParallelism=false --maxWorkers=1`，分别连接PG13.23 / PG16.15 | 各14/14通过 | 四时间域、北京23:59:59.999至次日00:00:00.000、来源可见权限/混场景拒绝；发厂缺省/手工精确边界、回滚、同key与不同key并发。`pg13-focused-final.log` / `pg16-focused-final.log`。 |
| 同配置运行 `tests/integration/sourcing-pr03-postgres.test.ts`（PG16.15） | 140/140通过 | 原外发完整套件，含旧整款普通时间缺省发厂、同key单事实。`pg16-original-sourcing.log`。 |
| `vitest run tests/unit` | 487文件、2585/2585通过 | 含新6项时间输入单测；先前定向4文件20项已包括在此范围，不重复累计。`all-units.log`。 |
| `node tests/acceptance/order-date-dispatch-time-browser.mjs` | 20个独立场景通过 | 桌面1440与移动触摸模拟390；4日期域、刷新/失败/保留草稿、已发布资料、整款/分批当前与毫秒手工、未知提交同key恢复。首4项和剩余16项分段记录，非声称单次全绿。 |
| `CASE_MODE=warehouse` / `CASE_MODE=conflict node tests/acceptance/factory-batch-ui-browser.mjs` | 4/4通过 | 用原140项导出的隔离PG响应，两个模式各1440/390；原提交、409反馈、无横向溢出断言。`existing-browser-*-fixed/result.json`，errors均为空。 |
| `npm run typecheck --workspaces --if-present`、`npm run lint` | 通过 | `typecheck-first.log`、`lint-final.log`。 |
| `npm run build --workspaces --if-present --ignore-scripts` | 通过 | 所有实际workspace build脚本执行，API tsc及web Vite构建成功；不是远端Gate。`final-type-build.log`。 |
| `secret-scan.mjs --worktree`、时间清单检查、原浏览器runner语法、`git diff --check` | 全部exit0 | `static-results.json`；未修改忽略项或扫描规则。 |

### 浏览器失败记录与精确修正

- 新runner首次因当前Playwright为CJS默认导出而启动失败，未进入断言；兼容默认导出并使用已有ESM入口。随后4个日期场景通过，负例夹具错误地把API错误message放在顶层，导致等待失败；纠正为原生产嵌套error契约后，仅补跑剩余16场景，无生产代码补修。
- 原warehouse/conflict首次均在组件挂载前失败，`result.json`准确记录 `jsxDEV is not a function`、results为空。旧runner未明确jsxDev，和所打包生产React不匹配；与已通过的新runner对齐 `esbuild.jsxDev:false` 后，仅复验这两个模式的4个场景，全部通过。没有增加10秒超时或放宽断言，不能将首轮初始化失败算业务通过。
- PG套件保留现有pg客户端并行query弃用警告；本轮无失败、无驱动/依赖升级，不冒称已消除该警告。

## 收口与未证明边界

- 只完成本地实现与验证，工作树HEAD仍为上述基线，等待独立推前审查；没有PR、远端CI或现场业务补验。最终Head和GitHub Review/Gate在后续实际执行后另记。
- 新PG的四时间域覆盖分批原生路径；旧整款使用原受支持历史夹具验证普通真实时间，两个UI均实测，且共用后端取时点。不声称旧整款全部历史迁移状态及四时间域均已原生重建。
- 浏览器使用实际产品React组件、隔离PG响应或合成HTTP；不能替代真实认证/服务端规则证明。移动证据为Chromium触摸模拟，不冒称实体Android/iOS原生日期选择器实测。
- 既有场景hook、审计/会话时间、SQL trigger、权限、迁移/checksum、原历史实绩均未改。其它分钟控件、返工附件、物流预计和部署明确留在原定其它范围。
