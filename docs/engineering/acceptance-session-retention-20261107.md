# Acceptance Lab 浏览器登录保持

## 开工范围

2026-11-07 用户明确批准：用户与助手各自浏览器首次验证后保持 30 天；普通 Acceptance 更新/重启保留控制与业务登录；主动退出、撤销和停用及时失效；切换测试角色不影响其他浏览器。授权独立创建 PR、一次 GitHub Codex Review、修复和正常合并。实际启用前由用户另行确认长会话安全影响，部署由用户执行。

目标分支 `release/digital-production-v1`，实际远端 base `a72b9553aa4210f10a88c1bd82e574654eba51e7`，工作分支 `acceptance/lab-session-30d`。风险 FULL（身份、会话及新增持久表）。不部署、不访问现场密钥、不修改现场配置或真实业务数据，不增加生产权限。

## 影响与完成标准

|批准规则|写入入口|读取与旧消费者|初始化、历史与反例|预期验证|
|---|---|---|---|---|
|首次一次验证、持久控制|AcceptanceControlAuthority.begin/end/bindBusinessSession|control/status、角色切换、原 AuthService 认证与退出|新增独立控制会话表；只存令牌摘要；原一次性控制码不放宽；老内存会话不虚构迁移|原控制码与路由测试；真实 PG 跨实例恢复、摘要、失效与并发|
|各浏览器独立|原角色切换与当前浏览器退出|原业务 AuthStore、原角色/人员状态重核|只撤销当前控制器关联业务会话；保留其他控制器；并发切换/退出不遗留有效令牌|同公司两控制器、同角色双登录、切换/退出竞态与停用回归|
|Acceptance 可选 30 天|原 SESSION_TTL_SECONDS 配置、server 组装与两类 Cookie|原生产配置和扫码/移动登录|不更改默认 8 小时；仅 NODE_ENV=test 且 Acceptance 启用时允许超过生产原 24 小时上限，最大 30 天；保持 Secure/HttpOnly/Path/SameSite 与跨源防护|配置允许/拒绝、Cookie 有效期、真实 HTTP 登录/注销|

使用原环境中的 `SESSION_TTL_SECONDS=2592000` 作为明确启用选择，不增加部署配置通道。本 PR 不设置现场值。既有 SESSION_SECRET/ACCEPTANCE_LAB_SECRET 在普通更新中保持时，已有会话应恢复；主动轮换控制密钥或数据库撤销则应失效。30 天是上限，角色切换不延长首次控制验证期限。遗失 Cookie 或浏览器存储仍须首次验证。

控制凭证代表隔离 Lab 的测试控制权，不代替业务角色。被停用的测试账号不得取得/使用业务会话；控制端不能据此扩大该账号权限。恢复账号不能复活已撤销令牌。

## 实际结果

最终源码指纹 `bcfb960157180c6604ebb67608ac4b7c3691fb9830a184f180336e7681f2cb77`。2026-11-07 本地实际通过：249 项原协议预检；179 项原控制码、配置、角色切换竞态、HTTP 登录/退出、跨源、迁移清单与canonical映射定向检查；20 项原生 PostgreSQL/Chromium 回归（新增9项及原角色8项、撤销3项），均无失败或跳过。类型、workspace构建、lint、secret scan、迁移静态校验退出码均0。精确命令、起止、来源和原日志/结构化结果摘要记录于当前 construction-evidence；尚不等于远端 Light/Review/Full 已通过。

新增原生场景实际包括：第29天重建全部app/auth/provider实例并继续两层登录、第30天精确拒绝与新角色期限收敛；同角色双控制器独立；并发跨实例切换与切换/结束竞态；数据库撤销/记录缺失、专用密钥轮换；原 EmployeeAccessService 停用/恢复后旧令牌不复活；HTTPS Cookie/跨源；两个真实Chromium独立Cookie资料经浏览器重启和后台实例重建继续使用。后台重建是重建全部服务对象，未冒称现场OS或ECS已重启。浏览器临时Cookie仅在测试内存，不输出凭证。

本地 Node22.22.2/npm10.9.9，Node限制CPU2,3；专有标记低权限PG16.15限制CPU0,1、2核/2GiB；canonical business-chain配置两worker、原100秒test/hook预算，pinned Chromium1194/Playwright1.56.1。既有资源前缀与精确清理保持，不称CI硬件或现场等效。新迁移权限清单仅追加0275的checksum/new-table项，未修改部署执行器或扩大生产时效。

实际启用前用户仍须单独确认较长会话的浏览器占有风险；本轮不修改任何现场配置，不部署、不操作真实业务数据。
