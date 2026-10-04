# 八项安全修复的 main / Acceptance / 固定工具兼容接入

## 范围与冻结树

用户仅批准1、2、3、5、6、7、8、10；4、9、11及管理员角色/权限不改。main业务PR635–638基于9fcc05c49dd7f236e2aad183b7e638780e9d63fc；Acceptance接入PR最初以dee990729f46e334450b34693bcb72027b07140f组装，现已rebase到合入A4的release/digital-production-v1 f842e11bb1b073563639464c335fb23d6e36ed21，不把A4整支带入main。

本候选仅接入四组安全提交及已核实修复：auth fb23754e + access测试4fef105a + Review准入/重试修复c562b3cb；Cookie db22bbb3；通知/CSV 15c969a9 + Review P2往返修复df8a8c6f；图片/XLSX b2a7e4c5 + 类型修复ca716253。接入`.env.example`冲突保留release已有digital flags，同时追加Cookie可选注释。release已有正确access/lifecycle fixture，故main上的两组测试修复在release不覆盖旧文件。未改digital UI、CSS、analytics、部署脚本、迁移SQL/manifest、lockfile或Root规则。

接入全部代码后的release code/test commit222b1c1ab14452b6f554663bf925be5017708f1f，tree48cc46a269953c50a38de144d03cefb443c44bda；main组合commit7cb8ac56（独立本地组合，不是待合并PR）。本证据文档后续只增加docs，最终交付必须以PR最终Head Gate与最终打包SHA为准，不能把code tree当最终发布SHA。

## 验证及准确边界

- 真实隔离PG13.23：main221与release237各自回放/再次零应用；checksum漂移及未知历史拒绝。用户身份数据均synthetic，不访问线上库。
- release组合：认证、access、生命周期、现有全业务链4个PG13 suite共52通过。最后CSV往返修复不修改任何PG行为；当前候选8个安全定向suite108通过，lint/typecheck/完整workspace build通过。之前完整无DBsuite1964通过/410跳过；最终Head完整suite由FullGate再次运行，不把skip当已测。
- main组合：最后安全定向107通过；当前main PG13认证/session/access/lifecycle15通过。此前完整无DB1876通过/321跳过。main既有PG13全链13个alias相关失败已在冻结9fcc05c4单独复现，release通过；本次没有把PR624业务alias修改接回main，尊重此前暂不处理analytics的选择，不能声称main所有PG13业务已绿。
- main的三个mapped access失败，与上项13个PG13故障分开：准确base本地逐项同样缺temporary_code两项及旧nextCursor一项；仅引入release已有正确fixture。fb23754e加此一个文件的PG16diagnostic4个suite49通过。无业务SQL、migration或Gate放宽。
- 固定工具183309300f2c62bbfb92212b778083c77adf9ece：用git archive取原不可变工具，执行其worker原始`[1/5]`代码片段与原始policy；不是重写一个等价检查。以真实本地PG导出的221/237 version/checksum/applied_at执行，前后hash不变，漂移拒绝。Acceptance237 pending=0；main221作为生产历史对release237看到16项原已有release历史差异，不表示要给生产main添加这16项。环境名称是fixture逻辑标签，未声称现场数据库身份或root完整update执行。见evidence/fixed-tool-183309-preflight.json。
- release包：现有package-release.sh成功生成API/frontend/manifest及SHA256SUMS；API health/live、version与迁移模块导入闭包通过；原create-transfer-bundle.sh无secret/无symlink检查通过，解包到新位置后重复API和迁移导入通过。最后CSV修复后重新构建；最终文档Head将另生成匹配SHA的包。
- Chromium153仅回环浏览器：同一validator+readSheet读官方15列表头、中文供应商及001234567890文本账号成功，bomb进入library前拒绝。未声称所有旧WebView均支持native deflate-raw。见evidence/xlsx-browser.json。

## 发现的既有 main 部署阻断

main当前package-release.sh未复制migration-history-policy.mjs、migration-branches.json、migration-main-extensions.json，但migration-lib.mjs已导入它们。实际main组合包API启动通过，迁移模块导入报ERR_MODULE_NOT_FOUND；这几个文件相对冻结main完全未改。独立诊断目录仅补这三份原文件，导入立即通过。

最小必要后续是打包copy清单加上述三文件（一个部署脚本），而不是改migration/重命名历史/跳检查/升级Acceptance工具。此范围外既有缺口只报告，未在安全PR擅改。main的业务安全修复验真不依赖这个包缺口，但任何main部署必须先收口它；不能以release包通过代替main包通过。

## 后续合并与部署顺序（本任务不执行）

1. 等main四PR最终Head FullGate完成；635/636/638各一次GitHub Codex Review，635唯一Review的P1/P2及637唯一Review的P2已修复后重新Gate，不发第二次Review。release接入PR最终Head也完成FullGate及一次Review。任何后续push使旧Gate失效。
2. 在main更新之前，保留这个已经验证的release接入PR及候选包证据；如果A4先更新release，重新以新release基线组装/验证最小接入，不能覆盖A4文件。
3. 获得另外明确合并授权后，按635→636→637→638合入main（或同样完整的逐组次序），仅这些提交；不把release/A4整支合main。随后合入对应release最小接入PR。合并SHA与PR SHA不同，发布前重新锁定准确main/release SHA并验证构建/版本一致。
4. main包闭包缺口须另行解决并验证；旧PG13 analytics失败按既有选择另列，不借此次安全工作扩展修复。没有迁移，main221和Acceptance237都保持原identity/checksum，禁止用main221包更新Acceptance237。
5. Acceptance继续使用已安装183309固定`dx-acceptance update <准确release40位SHA>`；本次无需install/工具升级，不clone/shared-clone服务器partial source。保留既有权限/历史/备份/版本检查；不手改已安装工具或白名单。若release后续引入新部署/迁移变化，本结论失效，须重新验证。
6. HTTPS回调会自动Secure；若现场是HTTP callback但HTTPS frontend，配置应显式SESSION_COOKIE_SECURE=true。没有修改现场值，也没有核实现场TLS/HSTS。部署仍需单独明确授权，本任务无合并、部署、真实钉钉通知、收费OpenAI调用或线上压测。

## A4合入后的最终组合

634已合入f842e11b（tree等于e5df9b37）。本安全分支从旧dee990基线rebase到f842e11b，所有34个A4修改文件相对新基线保持逐文件一致；没有改UI、A4业务查询、migration或工具。635首次Review的global-IP预算与busy callback修复也已最小接入。最终Head、CI和准确SHA包证据由PR639末尾评论锁定，不将早期证据JSON的候选tree误当最终Head。

main包失败的实际命令为Node22运行 `node -e "import('/tmp/dx-security-packages/main-candidate/api/scripts/migration-lib.mjs')"`，首个ERR_MODULE_NOT_FOUND指向打包的scripts/migration-history-policy.mjs。最小diff只需在scripts/deploy/package-release.sh现有cp列表中加入scripts/migration-history-policy.mjs、scripts/migration-branches.json、scripts/migration-main-extensions.json这三条既有路径；本任务未修改。

f842e11b组合：lint/typecheck/build通过，安全及A4前端11个suite125项通过；真实PG13.23认证/access/生命周期/全业务链及A4改动的三个digital suite共7个suite81项通过。34个A4文件与27个安全文件集合无交集。用户随后明确授权独立补main打包三依赖清单，该部署小PR另跑FullGate/唯一Review；不扩展SQL或analytics范围。

## 唯一Review末项修复

PR639在123f460d首次Review发现P2：登录的目录容量不足可能在一次性凭据消耗后才返回busy。已与main同步最小修复：在state/code消耗前预留目录容量，protected查询不能挤占未知身份预留；转换为目录read和提前失败释放都受同步计数/finally保护。protected单身份waiters仍32，public独立16，总等待者最多48，无身份结果TTL缓存。两项回归在原准确服务Head复现2失败/36通过，修正后38认证测试通过；最终新Head重新Gate及包闭包，不请求第二次Review。
