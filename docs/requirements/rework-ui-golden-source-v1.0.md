# 返工 UI 全平台统一规则 V1.0

状态：业务负责人于 2026-09-05 明确要求；本文件与对应实现 PR 一同生效。

## 1. 唯一标准

返工模块已经使用的 UI 是全平台现有页面与未来开发的唯一视觉和交互参数标准，覆盖导航、画布、表面、边框、字体、字号、字重、行高、颜色、状态色、阴影、圆角、尺寸、间距、图标、按钮、输入、搜索、选择器、表格、列表、分页、弹窗、照片和流程展示，以及响应式断点、触控尺寸、折叠与交互状态。不得把“统一 UI”缩小为导航或配色一致。

本轮源代码锚点是 main@5ae41c64eb286bee4392cc5a49fbc2fd11b61a8e 的返工实际实现。后续通过明确批准的返工/共享设计系统 PR 更新基线，不能因为其它模块已合入 main 就自动获得新的 UI 标准地位。

发生数值冲突时：返工同类型控件的实际完整样式与断点行为 > 承载这些样式的共享组件及 token > 业务规则中的旧数值表 > Figma、历史稿和截图。Figma应同步返工标准，不能反向迫使已验收返工页面改成另一套参数。

## 2. 基准继承矩阵

| 控件/页面元素 | 实施来源 | 继承要求 |
|---|---|---|
| 颜色、圆角、间距、字体族、阴影 | packages/ui/src/tokens.css；返工同类控件状态 | 按语义复用，不另造调色盘；缺 token 先从返工真实值补齐 |
| 普通录入表单 | apps/web/src/rework-v2-form.css | 桌面输入最小42px、窄屏最小48px；白底、1px #c9ced6边框、10px圆角；窄屏输入16px；完整继承标签、间距及聚焦状态 |
| 内嵌 Field | packages/ui/src/components.css 的 dx-field | 保持返工同类内嵌控件的44px及内嵌表面；不与普通表单混为一类 |
| 按钮和状态标签 | packages/ui/src/components.css及返工语义变体 | 普通按钮最小40px；移动提交操作采用返工48px；同意/驳回等既有语义颜色保留 |
| 平台一级/二级导航 | components.tsx、shell-navigation.css、workflow-shell.css | 各业务模块调用同一组件；同级文字布局一致；图标不受长文挤压，副标题保留返工看板的两行高度，超长截断且可查看完整说明，不得无限换行撑高卡片 |
| 流程节点 | rework-detail.css、rework-detail-compact.css、workflow-state-visual.css | 继承返工流程状态、编号、展开折叠；流程导航与平台模块导航是不同用途 |
| 搜索、选择器 | search-select、factory-search及返工表单容器 | 复用完整交互、键盘操作和空状态，不能只复制外框 |
| 列表、表格、分页 | order-board-page、list-pagination及返工查询页面 | 同类型列表和页码采用已运行组件，保留权限和分页逻辑 |
| 弹窗、确认、错误 | system-dialog、dialog-visual-system、返工错误摘要 | 复用平台弹窗及状态；不得使用原生alert/prompt替代 |
| 照片及上传 | 返工图片和image-viewer组件 | 沿用文件限制、预览、折叠及补图能力，不另建上传体系 |
| 侧栏与页面边距 | styles.css、workflow-shell.css | 侧栏280px；桌面边距32px，800px及以下16px，520px及以下12px；保留底部安全区。以最终CSS层叠结果为准，不得引用旧240px侧栏或统一20px移动边距 |

同类型使用同参数，不代表把单行输入、文本域、列表行、工作流节点全部强制同一高度；业务布局和用户已明确指定的功能布局不因参数治理改变。

## 3. 现有页面同步与未来约束

1. 参数应沉淀在共享层；返工和新模块共同引用，禁止每个模块再复制一份数值。
2. 供应商、外发、待办、回货和平台管理的同类型元素均须按继承矩阵检查。未来样衣与生产模块同样适用，不引入其业务逻辑。
3. 改动以同值提取和定向接入为主，不重命名原有CSS类、不替换组件库、不改流程、权限、金额或业务布局。
4. 新业务模板可以有不同信息排列，但必须由返工基准组件组装。
5. 页面私有样式只能决定业务排列，不得重新覆盖已统一的控件颜色、尺寸、字体、圆角、阴影和断点。
6. 旧规则中“共享输入统一44px”“移动边距统一20px”等与返工实际冲突的声明停止作为通用基线。

## 4. 验收与防复发

每次共享UI变动必须提供源页面和目标页面的同类型控件对照，检查最终计算样式与框体边界，覆盖1440×1024、1280×800、768×1024、390×844、360×800。检查默认、选中、禁用、错误、长名称和多行数据；不能把CSS中出现token或CI通过当作视觉验收。

新增页面的PR描述必须写出继承矩阵中的具体源组件。只允许显式批准的共享设计系统PR变更标准；没有真实浏览器证据的项目必须标记未验收，不能宣称全平台已经统一。

## 5. 本轮预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: 5ae41c64eb286bee4392cc5a49fbc2fd11b61a8e
- working branch: fix/rework-ui-golden-source
- task scope: 固化返工全平台UI基线并统一供应商与外发同类控件，修复明细缩进。
- allowed files: AGENTS.md、docs/roadmap/platform-2.0-rules-index-v1.0.md、docs/requirements/rework-ui-golden-source-v1.0.md、docs/requirements/sourcing-supplier-production-v1.0.md、packages/ui/src/、apps/web/src/相关共享组件和样式、对应验证证据。
- forbidden files: 数据库迁移、API业务逻辑、身份权限、ERP接入、部署配置、SSP-06与样衣业务代码。
- gate: 本地lint、web类型检查与构建、真实页面对照；共享UI使用Full Gate。
