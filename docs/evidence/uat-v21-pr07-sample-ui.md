# PR07 样衣操作 UI

- repository: lizhonghao31-crypto/dx-rework
- route: PR07
- base branch: main
- base SHA: 49e535e53221e68f554266479272eae19f51dfb0（远端核验）
- working branch: feat/uat-v21-pr07-sample-ui
- task scope: 接入已批准样衣目录、详情与操作表单布局，保留既有业务。
- UI sample status: 用户“我看到了，通过”；样板提交 39aff78010bfaa14924deff07ec3b412fc603983。
- sample: https://dx-pr07-samples-20260907.lizhonghao31.chatgpt.site
- required gate: Full Gate；当前 Head 全绿后最多一次 Codex Review。
- authorization: 本轮 Work 自主修复、必要 Review 与合并。

允许路径：apps/web/src/sample-workspace-page.tsx、apps/web/src/sample-workflow-page.tsx、apps/web/src/sample-create-page.tsx、apps/web/src/sample-disposal-page.tsx、apps/web/src/sample-catalog.tsx、apps/web/src/sample-operations.css、apps/web/src/sample-catalog-model.ts、tests/unit/sample-catalog.test.ts、docs/evidence/uat-v21-pr07-sample-ui.md、docs/evidence/pr07-sample-ui/*.jpg、docs/roadmap/uat-ui-data-upgrade-execution-v2.1.md。

禁止修改：后端、数据库、契约、身份权限、金额和状态规则、生产数据、共享 Shell/设计参数、返工及供应商模块、CI/部署/依赖配置。PR04历史单价P2不夹带。

## 集成边界

沿用样板行结构与CSS；合成数据、模拟历史、模拟状态和上传不进入业务。目录默认借出中、服务端15条分页及稳定人员ID筛选保持。批量归还只选当前页有资格的对象，照片上传、幂等键、版本及逐项结果继续由现有组件处理。缩略图只使用实体授权附件接口中的样衣图片，不使用采购小票。

## 验证记录

本地定向 eslint 通过；严格 TypeScript 检查通过（仅共享Shell/Auth使用类型桩）；真实业务组件的隔离 Vite 构建通过。5个定向测试文件共32项通过，包含原上传消费端及金额输入回归。样板已做五尺寸浏览器检查、长名/大金额/无图/只读详情/空筛选/错误重试及模拟借出与批量归还检查。这些不代表业务 UAT。

未部署 ECS，未操作生产或540件迁移样衣。回滚为撤销本PR的前端及证据变更，无数据库回滚。


浏览器真实组件使用18条合成记录和隔离响应，Shell/Auth替身不代替真实登录及全壳UAT。五档尺寸目录截图、手机详情和建档截图已保存。实点选中两件后清单仅包含两件，缺照片提交禁用；数字分页第二页只有第16件且清空勾选。只读列表/详情没有金额与写入按钮。图片使用隔离静态响应核验；实际下载沿用原实体授权路由，未验证生产OSS。缩略图每页最多15次附件元数据读取，无轮询，采购小票不作为缩略图。最终完整门禁由当前PR Head的GitHub Actions执行。
