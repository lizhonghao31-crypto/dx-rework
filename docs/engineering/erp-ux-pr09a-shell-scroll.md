# ERP体验PR09a：Shell导航组留白

独立基线release/digital-production-v1@0e198f0989050d7fd7a400b7a6a9453bde71cbfd，V3-024。FULL Gate。生产代码仅为unified-shell.css中既有桌面导航增加align-content:start；无JS/菜单、授权、路由、当前选中、品牌、身份、Header、业务内容、字号/颜色或触控尺寸修改。未合并/部署，不触及真实业务API、数据或OSS。

源码与计算几何先区分实际生效规则：Shell引入的unified-shell.css已把内部primary-navigation设为overflow:visible/max-height:none，外部desktop-navigation为单一滚动；本包没有重复“修复双滚动”。实际问题是外部导航同时display:grid和flex:1，默认轨道在短导航下被剩余高度撑开。师傅角色6个合法链接时，1440×900的全局/两个关闭分组分别多出约139.86/139.88/139.88px空白；管理长导航26链接无此剩余空间。仅使网格内容从顶部排列，保留原8px组距与原滚动容器，短导航空白归零。

21菜单来自本次原始附录E：待办、座舱、实时看板、填报、回货、板房、板房沙盘、价格、外发待批/历史、裁床、裁后发厂、返工、财报、供应商目录/维护、样衣在管/待确认/已处置/金额、工资。实际Shell按App原active/appearance/URL参数及对应模块样式加载上下文执行（实时展示看板按原active=实时看板、digital模式），业务正文为明确的代表性表单/表格与代表性类名哨兵，非各原页DOM，不调用整页业务组件或授权API；强制工人角色样式上下文也不表示该角色获准访问全部页面。不是21整页/手机版业务验收，更不扩冻结250项分母。

验证为21上下文×管理者/师傅两角色×1440×900、1366×768、1366×480、720×450、390×844五视口，共210帧。固定旧CSS保存同样210帧；新实现逐帧对照Header/表单/表格/主动作几何和全部菜单文本/href/选中属性完全相同，关闭分组不再被拉高。两角色的长导航展开/Tab到最后合法入口、至多一个导航滚动容器、身份区低高度可见，以及手机“更多”键盘开关分别回归。0页面异常/外部请求。720×450仅模拟1440×900在200%时的减少CSS视口，不声称真实浏览器缩放或物理触控。Shell原通知claim在fixture内返回404，不读取/认领真实通知，没有服务侧写入；不把该合成拦截计成业务只读实测。

另在未合并前序的独立源副本仅替换这一份CSS，与PR01/04/05/06/07/08组合，实际开发/杂事/预算/供应商/外发控件六组回归通过，包含前包完整值的键盘末尾/AX/focus净距断言；没有分支/index/release合并，不把前序整包重复进本PR。Web类型/构建、改动ESLint、secret/diff检查，本地全量2373通过/562条件跳过分别记录。原始截图/代表性Shell几何不能代替对应宿主09b–09f的正式布局或真实角色接力。

截图审查：短导航默认分组集中于顶部、品牌和身份保持原位，展开态保留焦点与导航可达；管理长导航仍可独立滚动，正文边界/宽度未改变。默认与展开截图分状态比较，不能把折叠前图和展开后图当同状态对照。没有全局缩字或取消边框。后续模块卡片/摘要/大表密度由对应包负责。

命令：既有Playwright/Chromium运行node tests/acceptance/erp-shell-scroll-browser.mjs；SHELL_SCROLL_EVIDENCE保存结果，SHELL_SCROLL_RECORD_BASELINE=1记录旧版状态，SHELL_SCROLL_BASELINE=1加载固定旧CSS，SHELL_SCROLL_FOCUSED=1重放短导航反例，SHELL_SCROLL_COMPARE指定原结果逐帧比对。回退只撤一个CSS属性，不触动业务事实。真实候选/Acceptance为POST_DEPLOY_PENDING。
