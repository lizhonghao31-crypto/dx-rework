# PR02 样衣上传修复

## 施工预检

- repository: lizhonghao31-crypto/dx-rework
- route: PR02 样衣上传阻断
- base branch: main
- base SHA: cc6d43ac3601765fdf58e4dc5cd5dc9047855c5a（PR01 #414 合并后已核对远端 main；上传源文件未被 PR01 修改）
- working branch: feat/uat-v21-pr02-sample-upload
- task scope: 修复空 JSON finalize 请求、中文分阶段错误与失败文件重试，保留小票必填及单件/批量共享方式。
- allowed files: apps/web/src/sample-create-page.tsx、apps/web/src/sample-request.ts、apps/web/src/sample-image-upload.ts、tests/unit/sample-upload-request.test.ts、tests/unit/sample-image-upload.test.ts、docs/evidence/uat-v21-pr02-upload.md、docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md。
- 附加隔离验证路径：scripts/sample-upload-preview.mjs、tests/fixtures/sample-upload-preview.tsx、docs/evidence/pr02-upload/mobile.jpg、docs/evidence/pr02-upload/desktop.jpg。
- forbidden files: 服务端身份/权限、数据库与迁移、生产数据、共享附件校验器、返工/外发实现、依赖锁文件、CI/部署配置、其余路线业务实现。

## 已核验定位

远端样衣公共请求函数无条件设置 application/json，而 finalize POST 没有请求体。工具上传路由本身不要求 finalize body。
使用仓库同版本 Fastify 5.11.0 的注入请求复现：无 body + JSON Content-Type 返回 400 / FST_ERR_CTP_EMPTY_JSON_BODY，处理函数调用 0 次；不带该头返回 200，处理函数调用 1 次。这证明代码缺陷，不能替代线上逐请求验证。

线上实际部署 SHA、上传/确认请求与业务新建尚未核验；UAT-01 保持未关闭。没有操作 540 件迁移样衣或生产开关，没有生产写入。

## 实施与定向验证

- sampleRequest 仅在实际带 body 时添加 JSON Content-Type，保留 credentials、no-store 与调用方请求头；上传确认空 POST 不带 JSON 头。非 JSON/不完整响应与错误码有中文提示。
- 上传分阶段提示准备、校验、申请、传输、确认；只接受 ready 附件。继续使用共享图片规范化重试及服务端严格校验，不修改公共上传器或服务器。
- 部分成功保留已成功文件，仅重试未完成队列；可以移除未完成文件再选。全表单记录正在上传的组件数，未完成图片阻止提交，不能悄悄丢弃选中的凭证。
- Vitest 3 文件 10 项通过（新请求/上传8项、既有单件与批量小票约束2项）；定向 ESLint 通过。
- 新 helper 与对应测试严格 TypeScript 通过，使用从远端契约原文摘取的声明，未替代完整 workspace typecheck。
- 浏览器通过真实 SampleImageUpload 处理两张本地生成 PNG：第二张确认模拟503后第一张保留，重试后共确认2张、申请3次；移除成功文件后数量正确；待重试时提交禁用。桌面/390px手机截图保留于 pr02-upload/，手机页面宽度390、scrollWidth390。
- 浏览器预览为离线模拟：Shell、HTTP响应、签名元数据均隔离；HTTP预览环境无安全上下文，哈希仅在预览适配器中替代为固定合成摘要。生产哈希函数未改；真实 OSS、服务端内容校验及完整建档/借还处置未实测。首次浏览器校验因该预览环境限制失败，未计为通过。
- 可复现离线控件命令：node scripts/sample-upload-preview.mjs <输出目录>。控件样例不是业务UI重新设计或线上UAT证据。
