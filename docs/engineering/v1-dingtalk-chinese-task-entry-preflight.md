# 钉钉中文提醒与任务入口预检

- Repository: `lizhonghao31-crypto/dx-rework`
- Base branch: `main`
- Base SHA: `572ecaab4395fb7b5e4d5d4a402682c105162a34`
- Working branch: `fix/v1-dingtalk-chinese-task-entry`

## 任务范围

- 现有业务待办创建后发送全中文钉钉工作通知。
- 禁用钉钉内置英文 APN/待办助手通知文案。
- 待办标题、描述和“我的待办”摘要不再展示订单号或“未填写”。
- 工序配置待办进入已有的完整返工详情工作区，并默认展开照片和流程。

## 允许修改

- `packages/contracts/src/todo-presentation.ts`
- `apps/api/src/todos/provider.ts`
- `apps/api/src/todos/deep-link.ts`
- `apps/web/src/my-todos-page.tsx`
- `apps/web/src/rework-detail-page.tsx`
- 对应的三个单元测试
- 本预检文件

## 禁止修改

- 工人待办生成或投递
- 数据库迁移
- 角色与权限模型
- 业务状态机、数量或金额
- 图片上传、OSS 与存储配置
- 部署配置、密钥及其他无关页面

## 实现与回滚边界

原生待办仍是任务状态的唯一权威；新增的中文工作通知只负责手机首页提醒。为避免同一事项重复弹出，仅在原生待办首次创建成功时发送一次中文通知。若需回滚，可独立撤销本提交，不涉及数据迁移。
