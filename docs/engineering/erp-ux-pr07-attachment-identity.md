# ERP体验PR07：附件身份与长文件名

独立基线release/digital-production-v1@0e198f0989050d7fd7a400b7a6a9453bde71cbfd，V3-007/036。FULL Gate，当前Head绿后本包一次必要Codex Review。没有迁移、文件模型/存储名称/内容/对象键变更，没有新业务命令、权限、工资/统计或状态机规则；未合并/部署，不调用真实业务API/数据库/OSS。

源码确认DevelopmentDocument.files只有attachmentId/kind，保存后的开发附件及工序成果拿不到真实原始名称，不能把“主款图1”伪装为文件名。新增必要的source范围只读metadata路由，先沿原service.read核source可见性，再调用与下载相同的ownedOrBound和相同绑定source/canDownload判定，仅返回attachmentId/filename/mimeType/sizeBytes。ready以外拒绝。该查询不读文件内容、不签下载grant、不写审计/业务数据；原下载路由和全部授权门槛不变。

| 入口 | 宿主与名称来源 | 可读机制 |
|---|---|---|
| 新建开发尚未上传/保存附件 | CreateForm的本地File，含既有prepare处理后的实际文件 | 用途/序号与真实文件名分别显示；不猜文件名、不请求临时ID metadata，不改保存payload |
| 保存后开发/历史资料 | 两个实际DevelopmentDocumentFields宿主由同source metadata投影读取 | 名称默认单行省略；原生details的名称本身可展开，title辅助hover，Tab/Enter/Space和窄屏触控可读全名 |
| 已提交纸样/车板/检测报告附件 | DevelopmentDocumentFacts原事实attachmentIds，同source metadata | 原“查看原附件”预览主动作保留，旁列原名/类型/大小；名称读取失败不影响原授权预览，提供只读重试 |
| 本次上传状态 | useDocumentUploadPreviews原File | 局部预览及完整名称独立于尚未保存引用/完成业务的原状态，不更改回执 |
| 旧打板制作资料 | PatternMaterials原filename | 默认一行名称、独立可展开；原键盘预览/前后切换/关闭及完整预览标题保持 |
| 旧外发照片 | 原附件响应filename | 原卡片一行省略及精确title；沿原Enter/触屏预览展示完整可换行标题，不新加照片页面/按钮或改变预览地址 |

AttachmentIdentity/AttachmentName为本轮局部展示组件，不是新的附件管理/请求平台。名称及必要类型/大小只从真实已有身份读取，技术MIME显示为PDF/JPG等。异步按路径隔离旧响应；失败结束loading并使用可读提示，不把英文底层原因直接当文案。局部details使用既有焦点token，coarse pointer名称目标至少沿现有44px控件token。原只读、busy、移除授权和预览URL保持。

本地附件授权/相关回归27项通过：只读投影不签存储、不启写事务；无权uploader、绑定允许/拒绝、pending/rejected、404及source不可见先拒绝均覆盖。全量本地2381项通过/562项环境条件跳过；API/Web构建、类型及改动ESLint/secret/diff分别留证。

实际开发表单、已提交成果和旧制作资料在1440、390、375宽各7类，通过原名、默认省略、hover属性/鼠标动作、键盘展开/收起、未保存本地File、失败只读重试、旧响应隔离、原预览完整标题；旧外发实际页三宽各3类，原预览入口和关闭保持。全部为隔离合成文件/响应，0外部请求/页面异常。固定旧Fields在同一名称用例中仍只有用途/序号，没有完整名称，断言失败。CSS 200%缩放与浏览器模拟触控明确单列，不声称真实浏览器缩放、物理设备或屏幕阅读器验收。原生下载建议名/响应头仍未验证，不能声称已修下载名。

与未合并前序只做独立源文件副本组合：PR01受控品类/草稿状态及其contract/选择器配套，PR04回执/离开保护、PR05历史版本/来源、PR06请求状态以及PR08局部控件规则均保持。CreateForm仅注入文件身份props，Facts仅替换附件renderer，外发仅增加title/名称规则；不把前序整包复制到本PR差异。组合Web类型、附件三宽各7类、PR01草稿两视口各10类通过；组合回执两视口各11类、来源两路径×两视口各7类、读取恢复两视口各13类亦通过，0页面异常/外部请求。实际后续接续仍须核共享diff及对应Head Gate。

命令：`npx vitest run tests/unit/digital-attachment-metadata.test.ts tests/unit/attachment-service-failures.test.ts`；现有Playwright/Chromium运行`node tests/acceptance/erp-attachment-identity-browser.mjs`及`erp-sourcing-attachment-identity-browser.mjs`。ATTACHMENT_IDENTITY_EVIDENCE保存证据，ATTACHMENT_IDENTITY_BASELINE=1仅重放固定旧Fields反例。回退只撤只读身份路由/局部展示，不重命名/删除任何文件或业务事实。部署候选和真实Acceptance仍POST_DEPLOY_PENDING。
