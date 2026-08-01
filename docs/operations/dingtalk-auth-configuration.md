# PR-02 钉钉准入配置清单

本仓库没有真实钉钉凭据，也不代表已经连通生产钉钉。联调前由管理员在部署环境注入：`DINGTALK_CORP_ID`、企业 H5 应用的 `DINGTALK_H5_APP_KEY` / `DINGTALK_H5_APP_SECRET`、浏览器 OAuth 应用的 `DINGTALK_WEB_CLIENT_ID` / `DINGTALK_WEB_CLIENT_SECRET`、`DINGTALK_QR_REDIRECT_URI` 与至少 32 字符随机值 `SESSION_SECRET`。两套应用凭据不得交叉换 token。可用 `SESSION_TTL_SECONDS` 调整会话期限（默认 8 小时），用 `APP_BASE_PATH` 配置 `/rework/` 等部署前缀。每次携带有效 session 的受保护请求都会通过钉钉复核组织状态；不得配置组织状态准入缓存窗口。

前后端挂载路径必须一致：根路径部署时 `APP_BASE_PATH=/`、`VITE_BASE_PATH=/`，OAuth 回调类似 `https://host/api/auth/qr/callback`；`/rework/` 部署时两者都设为 `/rework/`，`DINGTALK_QR_REDIRECT_URI` 应类似 `https://host/rework/api/auth/qr/callback`。Vite 开发代理会把 `<base>/api/*` 剥离为 API 内部的 `/*`；登录页面使用 `<base>/auth/*`，不得混用。

生产 Nginx 模板的 `location ^~ /rework/api/` 必须保留在 SPA fallback 之前；其尾斜杠 `proxy_pass` 会把外部 `/rework/api/auth/me` 与 `/rework/api/protected` 分别剥离为内部 `/auth/me` 与 `/protected`。根路径 `/api/` 代理保持相同的前缀剥离契约，不得修改 ERP 或其他 vhost。`location ^~ /rework/assets/` 必须把 Vite 的前缀资源 URL 映射到 artifact 的 `assets/` 目录，缺失资源不得回落到 `index.html`。模板在 `http` include 层定义并显式使用 `dx_rework_query_free` access log 格式，仅记录 `$request_method` 与不含 query 的 `$uri` 等运维字段；不得改回会记录 OAuth callback query 或完整 Referer 的 `combined` 格式。

公开的移动登录和 QR challenge 创建端点使用有界、按来源与端点隔离的分钟级限流；响应和日志不得回显 OAuth code、state 或 query。Fastify 只信任来自本机 loopback（`127.0.0.1`、`::1`）Nginx 的代理链，Nginx 必须保留当前覆盖 `X-Real-IP`、追加 `X-Forwarded-For` 的配置；不得将任意外部代理加入信任范围。服务端在创建这些短期记录前事务清理 `auth_consumed_codes` 与 `auth_qr_challenges` 的过期行，以控制匿名流量产生的持久化数据量。限流是纵深防御，生产入口仍应配置不记录 query 的上游防护策略。

必须在钉钉管理后台核对应用归属公司、移动免登权限、通讯录成员读取范围、浏览器 OAuth 的 `openid corpid` scope、回调白名单及 HTTPS 域名。联调验收须使用本公司在职、离职/禁用、外部组织及未绑定角色的测试账号分别验证；不得用显示姓名绑定身份或角色。

正式环境必须通过 HTTPS 设置 `Secure`、`HttpOnly`、`SameSite=Lax` cookie。任何 secret 只进入环境变量/密钥管理系统，不写入仓库、日志或前端构建产物。
