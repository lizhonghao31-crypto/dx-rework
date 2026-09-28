# 数字生产平台｜测试与发布底座闭环

## 目的

补齐四项前置工作的最后一项：候选版本在独立 Acceptance/UAT 环境部署后，可以自动留下“精确版本 + 权限矩阵 + 浏览器截图 + Root业务入口”的可复核证据，再进入UI真实验收。

## 本PR完成的能力

1. Acceptance 配置加载修正：部署环境允许读取 `ACCEPTANCE_LAB_ENABLED` 与 `ACCEPTANCE_LAB_SECRET`；生产仍由应用配置层拒绝 production + Acceptance Lab。
2. 合成测试母单根记录：真实 Acceptance 部署后，幂等确保3个 `digital_production_v1` 测试母单根记录存在，只写隔离库，不伪造尚未确认业务字段。
3. Acceptance Lab 自动接力：真实浏览器进入Lab，通过页面运行全部角色权限矩阵，再切换到 [UAT] Root 并打开真实业务入口。
4. 浏览器证据：保存控制页、权限矩阵、Root身份和Root业务入口截图；失败时保存 failure 截图。
5. 候选版本锁定：`acceptance-result.json` 和 `candidate-lock.json` 记录精确40位Git SHA与Schema版本，Artifact名称也绑定该SHA。

## 边界

- 不自动部署生产。
- 不修改现有生产订单或真实待办。
- 不发送钉钉外部通知。
- 合成根记录不是完整业务订单；业务字段确认后再扩展。
- 浏览器自动化负责稳定回归与证据；UI视觉是否符合认可图仍在下一阶段按“参考图→真实截图→调整”验收。
