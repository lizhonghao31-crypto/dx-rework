# 纠错后老板审批：裁床行身份修复

适用 main 0221 → 0222；Acceptance 使用同名、同 checksum 迁移并保留数字化生产既有历史。

订单纠错的有效明细来自追加纠错记录，创建明细保持不可变。原裁床外键指向创建明细，新增款色位置会在老板批准时报 23503，整个批准事务回滚。0222 在删除旧创建行外键前先验证审批快照与订单的组合外键；审批快照行外键和匹配来源触发器继续执行。四个来源外键数量保持不变。

迁移只改变约束，不补造创建行，不重写订单、纠错、审批、合同、裁床或审计记录。已存在的纠错订单无需回填；后续正常批准使用当前有效明细生成不可变审批快照。原失败事务没有提交时可按正常业务权限重新发起批准；不得直接修改真实订单状态或伪造批准记录。已有合同、财务核对限制及历史只读行为不变。

上线顺序：先交付 Acceptance 工具兼容修复，再将 main 0222 纳入获批准的正式发布。旧工具 183309300f2c62bbfb92212b778083c77adf9ece 仅知道 main 0221，遇到 main 0222 与数字化生产 0222 的双身份会拒绝；不要删除、改名或改 checksum 绕过检查。新工具的包包含 migration-history-policy.mjs、migration-branches.json 和 migration-main-extensions.json，必须作为一个完整工具版本安装。Acceptance 目标 manifest 为 238 条，schema 最后名字仍为 0233；核验完整 manifest/count/checksum，而不能仅核验最后版本名。

隔离 PG13.23 回归包含新增/减少/重排纠错明细、旧约束 23503 复现、失败事务完整回滚、失败 key 正常重试及成功 key 幂等、裁床及生产数量映射、跨订单/不存在的审批行拒绝、历史创建与裁床记录保持不变。未对线上订单或数据库执行操作。

本次隔离 PG13.23 完整迁移重放：main 221→222（1 条）、Acceptance 237→238（1 条）、main 222→Acceptance 238（16 条）、空库→main 222、空库→Acceptance 238 均成功；每条路径第二次运行均应用 0 条。旧安装工具对 238 条目标报 `Migration sequence gap or unapproved duplicate`，更新后的 policy 与完整 JSON 输入支持目标并继续拒绝 checksum drift、缺失迁移和未知第三身份。所有数据均为隔离测试模型。

工具获取与安装必须使用独立远端完整对象仓库：在新临时目录执行 `git init`、为固定 GitHub 远端设置 origin、正常 `git fetch` release 分支（不带 depth/filter、不从 `/opt/dx-rework/source` 本地 clone），再检查不是 shallow、无 promisor/partialclonefilter 配置且 `git fsck --full` 成功。本次隔离环境已验证该路径的 fetch、完整性检查和 archive。线上认证使用现有 dxrework 身份，认证与具体合并 SHA 必须在发布交接时核实，不宣称本地验证等于 ECS 已执行。

等 #645 实际合并后，以核实的 release 合并 SHA 创建干净 detached checkout，复用已有 `bash scripts/dx-acceptance.sh install` 一次安装完整工具；该入口只写不可变工具版本和原子替换 launcher，不迁移业务数据库或重启业务。核实 launcher/TOOL_SHA 和新权限清单后，才允许后续正式发布 main 的实际合并 SHA。以后此修复对应的 Acceptance 更新复用 `dx-acceptance update <实际候选SHA>`，不必每次重装工具。禁止将 PR Head 冒充合并后的部署 SHA；本次未执行安装、合并或部署。

Acceptance 初次 Review 的 P1（0222 缺少 checksum 绑定权限清单）已补齐：两个 ALTER 表要求 OWNER，外键目标要求 REFERENCES，新增表/序列及数据写授权均为空。PG13.23 低权限回归验证任一表由应用角色所有时预检拒绝且迁移历史不变，修复测试对象所有者后升级成功并幂等。另加完整待执行清单 checksum 覆盖测试，避免新迁移遗漏库存。
