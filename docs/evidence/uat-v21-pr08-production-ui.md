# PR08 实时生产 UI 与动效

- repository: lizhonghao31-crypto/dx-rework
- route: PR08，固定13个PR不变
- base branch: main
- base SHA: 1e797116712c8aebd0e4dfb9ab5da5de2d6a94f6
- working branch: feat/uat-v21-pr08-production-ui
- task scope: 复用生产样板行布局和动效，保留真实接口、风险/进度及历史。
- UI sample: 0b6e02ef4955832ed3e49813d38bae2fa7acb133；用户新增授权后续UI直接执行，不再逐次确认。
- required gate: Full Gate，最多2轮；Review按本轮风险判断、最多一次。

允许文件：AGENTS.md；docs/roadmap/uat-ui-data-upgrade-v2.0.md；docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md；apps/web/src/production-dashboard-page.tsx；apps/web/src/production-dashboard-model.ts；apps/web/src/production-board.css；apps/web/src/production-reporting-page.css；tests/unit/production-dashboard-motion.test.ts；docs/evidence/uat-v21-pr08-production-ui.md；docs/evidence/pr08-production-ui/*.jpg。

禁止：后端/契约、数据库、身份权限、生产数量/状态/风险计算、排除对象规则、生产数据、其他模块、共享Shell/设计token、CI与部署配置。

样板：https://dx-pr08-production-20260907.lizhonghao31.chatgpt.site ，录屏为同站/motion.mp4。保留既有真实动态、主动刷新、1.6秒一次高亮和250ms过渡；补齐8秒浅纹理、统一暂停、减少动态/文档隐藏/视口外保护、本地分钟相对时间。纹理仅在已上报且仍生产中有效已完成区域播放。错误保留最后成功数据和截至时间，不新增API轮询或WebSocket，不前端重算风险。

样板已五尺寸浏览器核验，并保存13张实际帧按实际时间间隔编码的低帧率动效录屏。样板统一暂停后活动纹理2→0；不是生产数据验证。实际业务组件核验与门禁施工中。ECS未部署，生产和540件迁移样衣未操作。

## 本地验证结果

- 定向 ESLint、隔离严格 TypeScript、动效边界单测2项及真实组件 Vite 构建通过。完整应用与后端回归以当前 PR Head 的 Full Gate 为准。
- 真实看板与填报逐款组件已用合成契约响应在五种固定尺寸打开；列表、多款详情、手机筛选、填报空数量禁用均核验。截图见同目录 pr08-production-ui。Shell、身份与生产管理控件在隔离预览中被替身替代，不构成生产权限或业务写入验收。
- 实际统一暂停使活动纹理2→0，恢复后2；合成503后6条旧记录与原截至时间保留，纹理停止；重试恢复。分钟计时无 fetch，真实组件超过一分钟后请求计数仍为1，而相对时间已推进；未宣称跨浏览器后台/系统减少动态实机覆盖。
- 填报只调整既有CSS布局，未改提交/修正/完工/发货处理、权限及幂等键。
- Review判断：本PR只读UI动效与局部布局，业务写处理、权限和契约不变；采用diff自查、边界单测、浏览器证据与Full Gate，不请求Codex Review（0/1）。
- 回滚：revert本PR；无数据库迁移、无生产数据操作、无ECS部署。

## 首轮 Full Gate 修复

Head 160f0b827859708eff392c59f47b82c5c088c3d6：Quick34133042345通过；Full34133060679的lint/type/build通过，1198项测试通过，唯一失败为 responsibility-queue-refresh.test.ts 将展示用visibility监听一概认成自动业务刷新。追加该测试文件到允许范围。仅对已审查、无fetch/load/request/dispatch的精确本地计时effect豁免；其他可见性触发读取规则保留。不是修改CI或Actions用量策略。修复后使用第二轮Full Gate，不盲目重跑。
