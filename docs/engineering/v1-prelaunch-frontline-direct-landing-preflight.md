# 一线岗位默认直达 Preflight

```text
repository: lizhonghao31-crypto/dx-rework
base branch: main
base SHA: 3734e54861c3730f800b7407ef7b6b83593d5425
working branch: feat/frontline-role-direct-landing
task scope: 单岗位一线账号按岗位与权限直接进入实际工作页，多岗位账号保留入口选择
allowed files: apps/web/src/landing-target.ts; tests/unit/landing-target.test.ts; tests/unit/v1-prelaunch-default-candidates-frontline.test.ts; docs/engineering/v1-prelaunch-frontline-direct-landing-preflight.md
forbidden files: 权限与角色配置、数据库与迁移、收货和报数业务页面、钉钉配置、部署文件、其他 UI
```

本次仅改变应用根地址登录后的默认落点：仓库收货、返工工人、尾查人员在岗位与 capability 同时匹配且只有一个一线岗位时，分别直达收货页、本人返工任务、本人尾查任务；同时匹配多个一线岗位时仍进入一线入口选择页。Root、老板和管理岗位继续进入管理工作台，显式业务深链不受影响。
