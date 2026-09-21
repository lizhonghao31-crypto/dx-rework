# UI-01 外发视觉试点与最小 DX UI（#542 历史记录，未完成视觉验收）

2026-09-21 更正：用户要求免除重复样式确认，不是免除测试或 Review；部署由用户执行。原 PR 未按批准参考图重排结构，以下改动不能代表 UI-01 完成。后续以 `ui01-reference-correction-20260921.md` 为准。

## 本次预检与授权

- repository: lizhonghao31-crypto/dx-rework
- base branch: main
- base SHA: b3e176d7d87419206c4c55e8b361406b2e75bfc4（#541，用户已完成合并部署）
- working branch: feat/ui01-sourcing-governed-20260921
- task scope: 外发视觉试点、老板审批专版及实际使用的最小 DX 组件。
- allowed files: packages/ui/src、外发页面与局部CSS、隔离样板及构建入口、直接相关断言、UI规则与本记录。
- forbidden files: API、contracts、migration、身份权限、业务金额与状态规则、云资源配置、其他模块页面。
- gate class: FULL（共享 UI）；不修改门禁配置。
- 原施工误读用户授权，跳过了必要的交付核验；此做法已被用户纠正，不构成后续豁免。

## 改动及继承

由现有 @dx-rework/ui 导出 KeyFacts、Disclosure、ImageStrip、WorkflowRail、ResponsiveFactsTable、ActionBar。原 React/CSS 实现，无外部源码复制、无新依赖、无 Motion。新增样式仅在 data-dx-ui="governed" 下生效；原 token 不改值。沿用既有圆角、字体、蓝色主操作及普通输入参数，手机输入 16px。对话框仍使用 SystemDialog 的既有样式，无新 portal。

外发创建、待审批／历史列表、详情共享局部表面层级。详情加工厂在事实区首位（PC 最左，手机第一）。老板只保留一份完整摘要与价格表；预算仅从获授权响应中的 daxingUnitPrice 读取，不使用 IE 或生产价替代。历史缺项不补造。批准／驳回仍原节点、原 capability 与成员限制，操作集中一处。

图片全部保留局部横滑与原大图预览，不增加附件请求策略；流程手机默认折叠，已完成节点可回看，未来节点不可进入；历史原生 details 按需展开。价格表使用原生 table 与明确列标题，窄屏仅表格局部横滑，金额沿用权威字段和原显示函数。

## 样板与验证事实

隔离合成样板：tests/fixtures/sourcing-governed-preview.tsx；五款长款号、长加工厂名、八图、只读岗位、预算裁剪、空列表与失败场景；禁止真实写入。使用 scripts/sourcing-price-preview.mjs 的可选入口构建，原默认预览入口保持。

#542 合并前曾完成类型检查和样板构建，但没有完成视觉核验；当时定向测试有一条旧结构断言失败，修改后未重跑。Full Gate 在合并后才成功，不能追认为合并前满足门禁。没有五尺寸截图、钉钉实机或容量证据，不视为验收通过。

## 发布与回退

无数据库和服务端变更，部署目标沿用原项目。批准上线不等于已部署，须以实际发布动作及目标版本为准。回退页面适配、局部样式与本轮未被其他页面依赖的组件即可，不回滚业务数据。CI 构建与运行依赖不新增。
