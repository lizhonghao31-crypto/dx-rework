# UAT PR03 施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1（本轮明确授权；main 不写入）
- base SHA: dda65b25777f2338baef5015d0aa129cefda72a3
- working branch: fix/uat-pr03-unified-development
- task scope: 单页开发草稿与首次客户订单确认，服务端编号防重和自然月交期。
- allowed files: 对应身份/开发服务与路由、数字生产/开发契约、设计师创建/编辑组件及局部CSS、定向测试与业务规则说明。
- forbidden files: ECS/部署/网络、真实数据、已完成旧模块内部业务、无关共享组件。
- gate class: FULL；最终 Head 一次 GitHub Codex Review。

## 实现

统一新建入口复用完整开发 document 字段组件；有／无客户确定订单在单内选择。真实逐 PO 颜色、尺码文本数量与客户仓到货日保存在可缺项的开发草稿中，本轮打板数量另存。草稿不建母单或执行任务；首次发布沿原事务生成执行任务，随后确认母单。附件失败保留已填内容与成功附件，发布已成功而确认失败时只重试确认。打开时的文档版本防止覆盖他人更新；切换订单意向同样触发未保存保护；重开后不同 PO 的独立日期不随首 PO 覆盖。

服务端按来源／母单各自设计款号作 ASCII 忽略大小写的串行防重；同来源复版及多 PO 不误拦。首次来源确认要求开发单已发布；成功幂等返回在日期门槛前处理。初次确认每 PO 客户仓到货日至少服务器北京时间当天加自然月，月底夹到次月最后一天；有确定订单的开发首次发布提前验证完整 PO、来源身份与日期，失败不会先建任务。订购草稿仅来源设计师本人／Root可读，普通技术阅读保留原开发字段，关闭创建开关后本人仍可只读。

业务规则已同步到 plan-v1.1.md §4.1、P01/P05 execution；历史缺失日期使用独立测试历史夹具保留，未放宽新建约束，未处理真实历史数据。

## 本地证据

- 全量 Lint、全部 workspace 类型检查、web build 通过。
- 全量单元测试 411文件／1999项通过；最后契约与开发字段定向 5文件／26项通过。
- PostgreSQL 身份／开发新保护 2文件／40项通过；任务、通知、实际开发办理、Journey与待办投影 6文件／76项通过。
- 仓库业务链脚本 29文件／329项通过，测试资源按脚本正常回收；本机没有配置真实 OSS，运行时 OSS preflight 按脚本跳过。
- 真实 build App＋隔离 API 浏览器通过：仅改意向时离开提示、上传失败保留／重试、草稿不发布不确认、重开完整资料／PO、两个PO不同数量／日期、不同开发／订购数量、旧版本拒绝覆盖、自然月日期前置拒绝、确认失败沿同一key重试而不重复发布。1440px五尺码列无无意义横滑；截图已目视核对。
- secret scan worktree 与 git diff check 通过。

浏览器材料：工作区 /workspace/uat-pr03-evidence；日志 /tmp/uat-pr03-browser-freeze.log。均为 TEST 合成数据，不代表部署或 Acceptance 业务验收。

## 交付状态

代码准备完成；本记录不代替当前 Head 的 GitHub Full Gate、一次必要 Codex Review 或合并证据。目标仅 release/digital-production-v1，最终部署仍由业务负责人执行。
