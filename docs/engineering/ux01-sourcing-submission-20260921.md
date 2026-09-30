# UX-01 外发提交反馈与错误定位

## 一次预检

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: bbbb56df1db5ee7d18144bb2d7f598f6b86fb4d8
working branch: feat/ux01-sourcing-feedback-20260921
mode: 逐 PR 交付
task scope: 外发创建、IE报价、生产管理选厂的提交反馈、字段定位、上传阻塞及同请求结果核对
allowed files: apps/web/src/sourcing-workspace-page.tsx；本次新增 submission-* 与 sourcing-submit-validation；对应测试／既有离线预览脚本；本任务证据、页面匹配与 UI Golden Source 修订
forbidden files: API业务实现、contracts/schema、数据库迁移、权限配置、其他模块UI、部署/云资源、现有真实数据
gate class: FULL
```

基准为 GitHub main；本地旧工作区已合并的 #540 权限测试改动不属于本 PR，不再次提交。修改前核对外发源文件 blob 与 main 相同。继承 `AGENTS.md`、`docs/governance/chatgpt-codex-construction-workflow-v1.0.md`、对应外发与 UI Golden Source；本轮批准计划来自《UI.docx》与 DX UI PR 施工方案 V1.1，批准补充在仓库 UI Golden Source 同步记录。

## 实际变化

1. 创建页缺性别、款式、日期、预算价、款号／颜色／数量、照片时，提交可触发汇总。校验失败不会创建订单；总数量、逐行数字精度和重复款色规则继续使用现有计算工具。
2. IE 逐款价格、生产管理加工厂／价格／工艺／其它裁床说明／调价原因先收集所有缺项。高于对应 IE 价格才要求原因，不能用另一款降价抵消；不改已有价格输入处理。
3. 一个主动提交只有一层呈现责任。复用 SystemDialog；弹窗“去修改”定位首项，页面摘要可定位各项。目标字段有稳定 ID 与错误关联，定位会展开原生 details 并聚焦／滚动。
4. 上传未完成／失败有明确阻塞原因，已有旧图片也不能绕过本批上传失败。点击提交查看原因不发送业务创建请求；上传失败通过同一摘要反馈。
5. 同步锁拦住同一事件周期的重复点击。请求前固定 key 和序列化 body；业务表单在提交中及结果未知时禁止修改。每次网络请求 30 秒截止；网络中断、写入取消、5xx、408、成功响应无法解析均按未知处理。
6. 普通初次 401／403／业务 409 与校验拒绝明确反馈。幂等处理中／幂等冲突的 409 属未知；核对时遇撤权或冲突仍不能断言原写入未成功。
7. “核对上次提交结果”复用原操作、key 和 body。服务端既有 `IdempotencyService.execute` 先查同 actor／scope／key 的完成记录，命中则返回原结果，未写入则按原请求执行；不是靠状态已变就假定是本人的提交成功。前端没有新增结果查询接口，也不冒称只读 GET。
8. 生产管理先固定工艺名称与决策内容；首次工艺解析成功后也固定 craftIds，核对阶段不因重新选择产生不同决策请求。创建重复款号二次确认仍保留，取消不再额外弹失败窗口。
9. 已确认成功先释放待确认状态，再清草稿／跳转或更新页面，避免本机草稿清理失败被误报为订单创建失败。成功后页面读取仍沿用既有读取路径；后台查询不新增弹窗。

## 明确边界

- 结果恢复限当前挂载页面内存；不新增包含工资／价格／附件的长期本地存储。刷新／关闭有未完成请求时使用浏览器离开保护，但强制关闭、移动系统回收或站内组件卸载仍可能失去内存快照。发生这些情况应先人工核查原单，不保证跨设备／跨刷新自动恢复。
- 后端幂等记录期限为 24 小时，本页面在原请求满 23 小时后不再发恢复请求，要求核查原单，防止过期 key 重建。
- 本 PR 不扩大到老板审批、转厂、派单、合同、财务、补款号的全部反馈路径，也不改变实时看板动画；对应后续清单有明确归属。
- 现有 SystemDialog 的所有原行为保持；本 PR 不宣称已经完成全系统弹窗可访问性或 UI-01 新视觉治理。

## 验证与未验证

- 校验行为测试：合法数据、一次多缺项、单行／总数量、代用号、重复款色、上传阻塞、价格精度、调价原因、工艺及选厂。
- 请求生命周期测试：快速重复调用只执行一次、响应丢失后使用同一请求、拒绝新的替换请求、撤权核对保留未知、明确拒绝可修正、超出保留时限不重放、成功后本地失败不重试写入。
- 外发既有定向测试、类型、代码规范、预览构建与生产前端构建均执行，准确数量／构建体积见 PR 当前 head 记录；不重复执行无关全库压测。
- 离线预览复用 `scripts/sourcing-price-preview.mjs`，新增合成 fixture，全部 fetch 在页面内模拟，不访问真实 API；默认原 fixture 入口保持。
- 当前浏览器安全策略拒绝本地 `file:` 预览访问，因此真实浏览器点击、焦点、PC／手机视觉与钉钉软键盘均 **未验证**。静态／行为测试不代替这些验收；预览构建成功不等于浏览器通过。
- 线上部署、真人岗位与 30+ 人容量测试均未执行。本 PR 的 Full Gate 结果、Codex Review 结果分别附于 PR，不提前填“通过”。

## 可复现本地定向命令

使用仓库规定 Node 22 与锁文件依赖：

```bash
npm run build:packages
npx vitest run tests/unit/sourcing* tests/unit/submission-attempt.test.ts tests/unit/system-dialog.test.ts
npm run typecheck --workspace @dx-rework/web
npm run build --workspace @dx-rework/web
node scripts/sourcing-price-preview.mjs /tmp/ux01-preview tests/fixtures/sourcing-submit-preview.tsx
```

预览控制可选择创建／IE／生产管理，以及成功、403、409、提交成功但响应丢失；页面显示合成请求数、key／body 是否一致。实际浏览器可用时，重点验证空表点击无业务请求、摘要各项跳转、IE 输入级联、403／409 保留输入、响应丢失后仅同键核对、一次成功反馈及进入下一节点。

## 性能和回退

无新增第三方 runtime、持续动画或轮询；只在当前页面有操作时产生反馈。包体应按同一环境基线比较，不能把旧 CI 与本地不同构建结果直接当作优化成果。正式 CI 首包与 CSS 增量记录在 PR，沿用 UI 组件累计约 5% 预算，不逐 PR 重置。

无 schema／数据变动。回退本 PR 的外发呈现适配及新增模块即可，不撤销合法业务结果，不放宽后端权限／校验／幂等。后续页面复用新增模块后，回退需保留已被引用的导出或同步回退消费者。

## Review 修复记录

开 PR 时仓库自动 Review 提出两项 P2；Gate 后另一次人工 Review 未新增 finding。后续不再触发 Review。重复身份检查新增结构化行索引，原消息接口与判重规则保持；UI 定位到实际重复行，不因第一行缺款号而吞掉后续重复问题。工艺名使用 trim + lowercase 预检大小写重复。新增后续行重复、首行缺项与代用款号重复同时存在、工艺大小写与空格重复用例；相关四个测试文件共 44 项通过，类型与 lint 通过。修复后最终 Head 的 Full Gate 结果以 PR 为准，不能沿用旧 Head 的绿灯。
