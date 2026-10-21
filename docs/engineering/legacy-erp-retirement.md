# 旧外部 ERP 对接退役（2026-10-21）

业务负责人确认旧 ERP 已不存在，不再有外部系统传入订单，授权删除该对接。此决定取代 startup-requirements-v1.2 中未来 ERP 接入、切换人工发起、管理员应急补录和补关联的旧约定。不是修复或启用非空 erpNodeId 路径。

## 已核调用与边界

运行时唯一装配是 server.ts → rework/routes.ts → ERP 专用路由；仓库没有 Web、钉钉或当前数字助手内部调用。删除 `/integrations/erp/v1/rework-orders` 下创建、补关联、原回执、结果读取，以及 `/admin/erp-emergency/v1/rework-orders` 和 `/admin/erp/v1/rework-orders/:id/result`，共八个旧端点。所有这些路径不再注册，返回404，管理员身份不能恢复入口。

同时删除仅供该通道使用的 service、身份构造器、结果投影器、Mock/Disabled adapter、契约导出、旧专用测试/Mock夹具和失效 P15 操作说明。没有独立 ERP 环境变量需要变更，原运行时仅硬编码 Disabled adapter；该装配一并移除。没有新增状态/权限/配置入口。

保留本系统人工创建、返工业务引擎、共用幂等/审计/待办、权限定义及历史非人工账号。保留全部已执行 migration、历史来源字段、接入/关联/审计表和数据；0109 守卫不变。历史订单沿现有受权的本系统 business-detail/历史入口读取，原权限不扩大。不增加 migration、回填或在线数据库操作。

名称带 erp 的现行业务 UI 验收、内部待办移交、外发订单 erpOrderNo 和通用 SourceReference 是本系统现行能力或历史兼容，并非本次旧外部通道，予以保留。docs/reuse/erp-reuse-audit-v1.0.md 等复用审查属于历史，不构成重新启用接口授权。

## 验证与恢复边界

新增 HTTP 回归装配真实 buildApp 与人工返工路由，逐个验证八个旧端点404、不调用鉴权或业务写服务，并保护人工草稿/读取及无权创建拒绝。隔离 PG 用明确的历史初始化夹具载入旧来源订单，随后只通过原生业务详情服务验证允许/拒绝、来源/接入/审计快照不变。夹具不提供运行时旧接入能力。

仅本地代码/隔离测试与一个 FULL PR；合并、部署待另行确认。代码删除可通过版本回退恢复；历史 schema 和数据不变化，不需要反向 migration。不改凭据、网络、生产/Acceptance 数据或任何模型设置。
