# ERP 体验 PR04：动作回执与当前状态

目标release/digital-production-v1，基线 `0e198f0989050d7fd7a400b7a6a9453bde71cbfd`；V3-017及V3-029的写回执部分。Gate FULL，当前Head绿后必要GitHub Codex Review一次。独立于PR01–03；不自行合并/部署，不访问生产或Acceptance业务数据。

已完成任务重新打开时，工作台底栏原先会显示“未提交业务变化”；旧成功提示也会覆盖后来的编辑。原提交成功后刷新失败的提示还声称“原输入已保留”，而成功提交的附件引用缓存实际上已清除。本次让回执分别依据成功命令和返回的任务/版本事实，并在新编辑、保存失败或切换读取时失效。

| 行为 | 结果与事实来源 |
|---|---|
| 完成页重开 | 原返回任务state=completed时恢复“本任务已完成”；不依赖内存成功提示 |
| 上传/业务提交 | 已上传但待引用的附件显示尚未随本次办理提交；命令被拒时原输入/附件保持，成功提交后才清引用 |
| 完成与下一项 | 只有原返回同一taskId已completed才说完成；仅显示同轮当前身份可执行的ready任务，不把别轮/他人任务说成本人下一项，也不从pending推断时钟尚未开始 |
| 特定登记与辅助动作 | 预派、报告、补料复核、客户样板确认、接收、改派、优先级及业务状态沿原端点分别回执，不泛称工序完成 |
| 写成功/刷新失败 | 独立记录已提交但结果未确认状态；不依赖表单dirty或已清空的附件缓存。重新读取成功前保留离开保护与原幂等键，拦截再次业务提交；重新读取失败继续保护，成功后清除此状态/原键，原未保存输入保护仍独立保留。补料、送洗等无编辑动作和共享执行宿主同样适用；只读恢复按钮不重发业务命令。其它读取loading/权限机制仍归PR06 |
| 制单 | 保存草稿、发布有效版本、核对采用资料分别回执；发布回执要求返回publishedVersion与当前version相等。原编辑稿与已发布快照共存，版本选择规则保持 |

`digital-operation-feedback.ts`是本次三个宿主的私有显示函数，没有新增全局状态/通知平台。产品改动在原execution、task-workbench及其辅助动作、instruction组件；命令字段、端点、权限、前置、状态机、工资、历史和Root能力均沿原实现。

验证：7项新反馈规则单元及既有制单采用/校验共17项通过。实际 `TaskWorkbenchSample`、`ProductionInstructionPanel` 本地Chromium在1440×900、390×844各11类行为通过，覆盖完成页重开、业务拒绝保留输入/已上传附件、旧辅助回执清除、上传待引用→提交→完成、写成功刷新失败保留离开确认→重开核实且不重复提交、制单保存/发布与失败回执。P1追加：无文本编辑的送洗/补料及仅附件提交，在接受写入后重读失败时仍确认离开；重读再次失败继续保护，只读恢复不重发POST，业务拒绝后相同payload复用原键，未确认时再次点击不发新请求；共享执行宿主同步核验。全部响应由合成fixture拦截，0页面异常、0外部业务请求，不使用旧设计样板作产品证据。

命令：`npm run build:packages`；`npx vitest run tests/unit/digital-operation-feedback.test.ts tests/unit/instruction-source-review.test.ts tests/unit/doc03-instruction-validation.test.ts`；设置已安装的PLAYWRIGHT_IMPORT/CHROMIUM_PATH后执行 `node tests/acceptance/digital-operation-feedback-browser.mjs`，可用OPERATION_FEEDBACK_EVIDENCE保存结果/截图。另完成改动ESLint、Web typecheck/build、secret scan和diff检查。

对应候选未部署，真实账号、上传服务、审计及跨角色交接为POST_DEPLOY_PENDING；自然故障、真人/真机不由受控fixture冒认。回退只撤显示映射和临时回执，不撤销已发生的业务提交、附件引用或发布；不清理真实数据。

一次GitHub Codex Review在原Head `844641be2457c8ddd2a5f64e466c9addefb6d717` 提出P1（discussion_r4302200159）。同一无编辑送洗反例在修复前确实无法出现离开确认。当前修复另取新Head Full Gate并交父窗口核diff/证据；不将旧Head Gate或旧Review冒作已审新增差异，不自行追加Review次数。
