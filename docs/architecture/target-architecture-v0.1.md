# 目标架构与 ERP 接入边界 v0.1

状态：启动基线  
适用阶段：独立试点 → 未来 ERP 节点接入

## 1. 架构目标

本系统首先独立解决内部计件返工的记录、核实、审批、执行、上数和追溯问题，同时确保未来能作为 ERP “质检返工”能力的细化服务接入，而不需要推倒重建。

## 2. 复用 ERP 的能力

| 领域 | 复用内容 | 本项目处理 |
|---|---|---|
| 前端基线 | React 19、Vite 8、Node 22 | 复用版本方向，采用模块化目录 |
| 钉钉 | 工作台免密、浏览器扫码 | 复用流程，增加本公司组织成员强校验 |
| ECS | 服务端配置、健康检查、部署与回滚 | 复用运维模式，使用独立服务/配置 |
| OSS | 服务端签名与附件上传 | 复用接口模式，禁止前端持有密钥 |
| GitHub Actions | 构建、测试、浏览器验收、SHA 证据 | 裁剪为本项目需要的流水线 |
| 审计 | 操作者、时间、动作与对象记录 | 扩充为业务状态前后值和审批链 |

## 3. 不直接复制的内容

- ERP 巨型单文件页面结构；
- 通行码正式登录；
- 姓名硬编码角色；
- 前端单独承担权限控制；
- Tailwind Play CDN 生产使用；
- ERP 页面内部变量或组件状态作为跨系统接口。

## 4. 逻辑分层

```text
DingTalk / Browser
        │
        ▼
Web Application
        │
        ▼
Application API
 ├─ Identity & Organization Gate
 ├─ Rework Case
 ├─ Verification
 ├─ Approval
 ├─ Execution & Piecework Entry
 ├─ Attachment Evidence
 ├─ Notification
 └─ Audit
        │
        ▼
Persistence / OSS / Outbox
        │
        ▼
ERP Adapter（未来启用）
```

## 5. 核心边界

### 身份边界

`DingTalk userId/unionId → internal userId → role → capability`

组织成员验证与系统角色授权分离。通过组织验证不代表自动获得业务操作权限。

### 业务边界

返工单是本系统核心聚合，状态变化必须通过应用服务完成，不允许页面直接改数据库状态。

### 集成边界

未来 ERP 只通过版本化接口或事件适配器接入：

- ERP 可发起返工；
- 本系统返回返工状态、结果和审计摘要；
- 双方以稳定业务 ID 和幂等键防止重复写入；
- ERP 暂时不可用时，本系统独立流程不应被阻断。

## 6. 预留字段

业务表应预留或等价实现：

- `source_system`
- `source_record_id`
- `external_idempotency_key`
- `erp_node_id`
- `created_by_user_id`
- `updated_by_user_id`
- `version`
- `created_at`
- `updated_at`

字段名称可在数据建模 PR 中调整，但语义不得丢失。

## 7. 非功能要求

- 所有写操作具备服务端授权；
- 状态流转具备并发保护或乐观锁；
- 钉钉回调、ERP 调用和通知任务具备幂等处理；
- 核心写操作产生审计日志；
- 附件只保存 OSS 地址与元数据；
- 健康检查区分应用存活、依赖可用与版本 SHA；
- 部署结果能够反查 GitHub commit SHA。

## 8. 当前未决但不阻塞基础建设

业务确认文档中的 S-01 至 S-04 在对应业务 PR 开始前必须落定。它们不阻塞仓库治理、身份骨架、设计系统和只读原型工作。
