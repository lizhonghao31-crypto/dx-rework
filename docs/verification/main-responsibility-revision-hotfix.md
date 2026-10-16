# main 外部责任重判批准修复

## 范围与基线

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 8c2beb55925c15d93e37e7cfaa42b635426a455b
- working branch: fix/main-responsibility-revision-500
- scope: 修复已完成返工单外部责任卡批准重判失败，保留原有效判责负责人。
- allowed files: final-external-responsibility-service、追加 migration/manifest、相关隔离回归与本记录。
- forbidden: release/digital-production-v1 新模块、生产数据、部署与服务操作。
- gate class: FULL（审批、事务、权限、数据库约束）。

用户提供的只读结果确认 current、active、运行 gitSha 均为上述 main SHA；运行 schemaVersion/expectedSchemaVersion 为 0225_warehouse_supervisor_cutting_read，appliedSchemaVersion 为 null。两份日志按已提供条件筛选均零命中，不能推导无异常或唯一线上根因。截图由父窗口核看，本修复窗口未直接核看像素。无需重复真实审批。

## 已复现的原因与修改

入口是 POST /external-responsibility-revision-requests/:requestId/approve。审批事务按申请和责任卡版本加锁，替代旧台账、重新开启订单、复制判责草稿并记录审批决定。

旧实现把批准人同时写成新草稿 handler_user_id；当批准人与当前有效判责人不同，数据库 guard_determination_insert 抛出 42501：only the effective handler may create the next draft。完整 main migration 合成链路已复现；原判责人本人批准能成功。旧外部责任测试仅使用早期 migration，未覆盖当前约束。

修复区分两个身份：

- Root / 原规则合法审批人负责批准，created_by、批准事件、草稿操作事件均保留真实审批人。
- 草稿 handler_user_id 和下一轮判责待办保留 responsibility_effective_handler，不因批准暗中改派。
- 0226 只允许同一可信批准事务、同一订单与历史定稿、仍待处理的申请生成草稿。普通草稿的原负责人限制继续存在；未提供匹配批准事件时无例外。
- Root 身份由数据库 access_is_root_actor 核实，不要求额外普通业务能力；普通审核人的原能力检查保留。
- 不自动执行申请内容中的新责任分配，不改历史责任、已扣款、工资或老板签字条件。

## 隔离回归范围

在独立本地 PostgreSQL 数据库中通过真实 N01—N11 合成订单、全部当前 migrations 和 HTTP 路由验证：

- 合法老板审核人 ≠ 原判责人，未扣款批准；Root ≠ 原判责人，未扣款/已有累计扣款 119.60 的批准。
- HTTP Root 身份来自 RootAuthority，认证输入不预置普通角色/能力；两类审计均保留 Root。
- 普通无权角色批准/驳回拒绝；非 Root 审核人缺判责能力仍拒绝。
- 驳回恢复原责任卡状态；重复驳回不重复写入。
- 批准末段人为抛错：订单、台账、申请、草稿、事件、待办、消息、工资、扣款全部不变；同一幂等键随后成功。
- 成功批准重放返回相同 HTTP 结果；换键重复批准或再驳回返回 409，无重复草稿/待办/财务事实。
- 历史定稿不变、工资和扣款记录不变、原负责人仅一条待办；重判定稿后已扣金额继续结转。
- 保留原测试中的订单级重开、老板签字/驳回、名单权限、超额扣款专批、工资和历史财务读回归，不以新路径替代旧路径覆盖。

本地与 GitHub 检查结果、一次独立 Review 和最终 Head/合并结果随 PR 交付，未运行者不得视作通过。本记录不宣称已部署或真实订单已恢复；部署由用户执行，线上原异常日志仍未关联到具体请求。
