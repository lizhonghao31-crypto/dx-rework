# Cookie 传输模式（批准风险 5）

预检：lizhonghao31-crypto/dx-rework，main 9fcc05c49dd7f236e2aad183b7e638780e9d63fc，security/cookie-transport，FULL。允许 config、app cookie接线、配置示例及对应测试；禁止线上配置/HSTS/代理边界、管理员权限、migration、A4 UI。

原 app 用 NODE_ENV=production 决定 Secure；Acceptance 强制 test，于是 HTTPS 运行时也省略 Secure。改为独立 sessionCookieSecure：生产或 HTTPS 钉钉回调 URI 强制 Secure；可选 SESSION_COOKIE_SECURE=true 支持在 HTTP 内部回调但 HTTPS 前端运行的场景；false 不得关闭生产/HTTPS保护。开发/test 的 HTTP 回调仍支持非 Secure。本次不修改部署启动脚本或实际环境变量。

业务session、QR binding、Acceptance控制session的设置和清理共用同一值，保留 HttpOnly/SameSite/path/TTL。config及路由定向测试50通过，增加HTTPS控制/切换/退出两种Cookie Secure断言；完整suite1847通过、318跳过，lint/typecheck/build通过。任何最后新增测试仍需最终Head Gate验证。

无需迁移、无需更新固定维护工具183309。main221和release237历史各自保持；release仅接入这几处共享代码，不能从main覆盖整个app或config文件。现场HTTP、TLS终止、HSTS及实际回调地址未核验，不能把本地配置/响应断言说成现场验证。部署前由既有维护入口验证配置；若实际使用HTTP callback+HTTPS frontend，应显式SESSION_COOKIE_SECURE=true，不自动编辑服务器配置。

未部署、不自动合并，不关闭扫描finding；未处理4、9、11。本地全部凭证与网络响应为fixture，无真实钉钉/OpenAI调用。
