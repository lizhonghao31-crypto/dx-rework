# 通知及导出动态文本（批准风险 6、7）

预检：lizhonghao31-crypto/dx-rework，main 9fcc05c49dd7f236e2aad183b7e638780e9d63fc，security/notification-export，FULL。允许todo Markdown发送边界、CSV通用helper及对应测试；禁止款号业务规范变化、管理员权限/审计（4、11）、识别费用（9）、migration、A4 UI。

6：原接收业务允许款号换行/Markdown，presentation将其放入subject/description，发送时直接拼接action_card Markdown。冻结main provider恶意payload regression失败，候选通过。现在在最终Markdown sink统一转义所有动态subject/description：ASCII标记/URI符号反斜杠、HTML字符实体、控制字符清理；subject换行归一空格。允许合法款号，普通todo API仍使用原纯文本。主按钮URL仍服务器提供，未改变deep-link路由、recipient或权限。采用sink处理，历史已保存业务文本也受保护。

7：原CSV只引用逗号/引号/换行，没有中和公式。新增公式前缀=+-@及空白/control绕过检测，用前导apostrophe输出文字；纯数字/合法负数/小数/科学计数业务值保持原样，CSV引用仍防字段分裂。现有inline-string XLSX导出路径不改。

定向helper和真实provider假HTTP测试24项通过；完整suite1859通过、318跳过；lint/typecheck/workspace build通过。provider测试明确检查恶意链接/heading/HTML不进入Markdown且按钮URL保持。全部fetch是本地stub，无真实钉钉通知。没有收费API或线上数据。最终Head FullGate、随后一次GitHub Codex Review另行记录，不以本地测试冒充。

无migration、无依赖升级/lockfile变化、无部署配置变化。main221、release237保留原历史；release provider/csv共享代码可最小cherry-pick，A4 UI不进入main。固定183309工具无需升级，候选仍须通过既有update preflight/包闭包。未自动合并/部署/关闭scan findings。


一次Codex Review指出P2：公式guard使导出再导入重命名已有资料。已核实真实master-data CSV入口。现在导出对原始leading apostrophe也追加一层，导入按同一文本约定只移除一层guard，保留原始apostrophe和危险前缀业务名称。外部CSV使用此约定时，欲保留literal leading apostrophe需双写；正常不带guard的原始CSV不变。补充供应商/工序名称及原始apostrophe round-trip回归；修复后重新Gate，不请求第二次Review。
