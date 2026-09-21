# UI-01 电脑列表恢复与移动布局修正

## 预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 914bc570ba2f532de65e718f5dbc4bebbfc68e06
- working branch: fix/ui01-responsive-boundaries
- scope: 恢复电脑列表原布局，修正手机列表及详情，统一图片/流程标题并将裁片日期纳入事实条。
- allowed files: sourcing-workspace-page.tsx、sourcing-governed.css、packages/ui/src/governed.tsx、packages/ui/src/components.css、对应组件测试、UI需求与本记录。
- forbidden files: API、数据库、权限、流程、金额计算、部署配置、其他模块布局。
- gate class: FULL；当前 Head 全绿后一次 Codex Review。

## 根因与处理

1. 列表将原生 dl 换成 KeyFacts 后引入了详情边框/内边距，公共样式在打包顺序中又覆盖同等优先级的列表规则。恢复原 dl 和桌面字段顺序，删除列表的 governed 桌面覆盖；手机规则全部限定在 max-width:800px 内。
2. 详情 KeyFacts 的列数也与公共默认规则同优先级。增加页面作用域确定布局；手机加工厂整行、四项数字两列、两个日期分别整行；桌面七项包含两个日期。
3. 补图按钮被后载入的 qc-file-button 默认尺寸覆盖，而且 space-between 将按钮推向中间。使用详情图片区限定选择器、28px按钮、紧邻标题；图片/流程标题栏32px同高。
4. 公共表格首/次列选择器包含伪类，比普通居中规则更强。详情居中规则增加父层限定，覆盖首列/次列且不影响其他表格。
5. 手机原三列 grid 加上全部居中导致每款过高。共享组件增加显式 opt-in compact 变体，以 flex 让整组数字换行，身份信息左对齐；原默认模式不变。金额和合计继续由原业务数据传入。

## 验证与限制

- 执行类型检查、定向 sourcing 单测、lint、生产构建和密钥扫描；结果以 PR 当前 Head 的 Gate 为准。
- 检查最终打包 CSS 的顺序与选择器，不能将源代码规则出现等同于实际生效。
- 浏览器本地预览在此前被自动审批拒绝，不绕过该限制。本轮不能声称已取得真实浏览器截图或通过视觉验收。
- 用户部署后关注电脑订单列表恢复情况，图片/流程标题对齐，以及手机款号/日期/数字不拆行、款式卡片密度。CI与Review不替代视觉验收。
