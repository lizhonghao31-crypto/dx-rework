# UAT PR06 施工预检

- repository: lizhonghao31-crypto/dx-rework
- base branch: release/digital-production-v1；PR05已合并45f6f268e9cae1dda3af974843c29c0b68577c24，本分支已同步对应集成基线。
- working branch: fix/uat-pr06-misc-associations
- task scope: 停止无来源独立打板新建，杂事独立看板及合法档案/PO稳定关联；历史打板继续办理和工资不变。
- allowed files: pattern-room创建/列表/材料、必要关联只读查询/合同/迁移、相关测试与规则文档；migration所需checksum绑定维护权限清单（只新增本迁移条目，不执行部署工具）。
- forbidden files: 生产部署/在线数据、来源/任务/工资状态机重写、清理或伪造历史母单。
- gate class: FULL；最终Head门禁后一次必要GitHub Codex Review。

## 实现与兼容

杂事看板只用原kind=misc列表，默认前后端15条；原历史列表/详情与待办URL保留。新增入口统一新增杂事，旧kind=pattern URL不渲染创建表单，公开create/POST连Root也拒绝；createDevelopment内部事务、原发布/价格/附件/工资路径继续使用。

新增可选授权档案/PO搜索，候选在SQL中按当前有效发起岗位、来源所有者或母单主跟单范围过滤，并保留具备发起能力者的原领导/技术管理读取范围后最多30项，再以原DigitalProductionAccessPolicy在提交事务内复核。稳定source/line ID与服务端label/style快照保存在0243新增的可空misc_association列；不猜字符串关联，不回填历史。选中后编辑成未匹配关键词会阻止提交且保留其他输入，清空时明确选择不关联。后端拒绝自由文本、选值不符、篡改/他人/已不存在的ID；提交时锁定现有角色和来源/PO行。

历史字符串在未改变时可继续保存，改关联必须选合法对象；历史节点按对应审计的关联快照回放。历史kind=pattern继续原编辑、派工、完工、返工、工资路径，测试专用historical-pattern-fixture仅从原私有事务组装器构建既有记录形状；未给生产增加任何环境开关或公开绕过入口，未造母单。

0243不修改旧行、金额、计价或工资资格。仅为新列补对应manifest和checksum绑定维护权限清单；未执行部署工具。代码回退时旧应用忽略可空列，保留历史快照，不自动DROP或回写数据。

## 本地验证

- PostgreSQL定向4项：Root/设计师/多角色管理读取/其他角色与旧POST的新建拒绝、无关联、合法来源/PO、同ID幂等、候选关键词/发起人授权范围、非法/无权/变更/已移除PO、历史字符串兼容与合法更换、31项15/15/1/0分页。来源根身份本身不可删除，保留原保护；并发删除场景使用尚未采用的测试PO行。
- PostgreSQL完整业务链29文件329项通过，包含开发发布生成原执行单、历史pattern全流程/工资、杂事0.1小时、先工时/先完成、确认与唯一工资资格；测试schema清理成功。OSS未配置，实际OSS预检按原脚本跳过。
- 全套无数据库449文件通过/62条件跳过，2314测试通过/549条件跳过。全量Lint、所有workspace类型、web build通过；迁移与精确权限库存/旧历史兼容定向6项通过。
- 实际build浏览器：misc-only列表15条、旧独立打板URL封闭、单一杂事表单、已有档案/PO稳定选择、同名客户可区分、关键词改成无效值阻止提交、空关联成功、服务失败保留输入/选择并复用相同幂等key、1440/390控件无页面横向溢出。新增字段的隐藏原生select在手机被旧表单宽度规则撑开，现仅对此字段收紧到1px且固定位置。截图/result在/workspace/uat-pr06-evidence/；桌面/手机逐张目视核对。

这些为隔离TEST数据，不是线上或真人并发验收。已同步PR05集成基线；待最终Head Full Gate与一次必要Review后合并；最终部署仍由业务负责人执行。
