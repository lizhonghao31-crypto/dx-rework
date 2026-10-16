# 0226 固定维护入口交付核对

预检：main 基线 08daf5e04022870f9487f5bd4c7ab70a3cc25e8e，独立分支 fix/main-0226-maintenance-admission；范围仅 #778 修复的可部署交付。FULL Gate。生产已知运行 8c2beb55925c15d93e37e7cfaa42b635426a455b / 0225 / 3203，未在本环境操作生产。

## 必要补齐

0226 migration、校验和及业务修复不变。登记精确维护计划，检查 public USAGE/CREATE/current_schema、guard_determination_insert() 所有者角色可用性、sql/plpgsql USAGE。此DDL不修改表或创建触发器，不要求无关表所有权/TRIGGER权限。普通在线入口继续拒绝schema差异。

维护入口新增可选 DX_REWORK_EXPECTED_MAIN_SHA：首次候选独立fetch后、解包/构建/DDL前核对SHA；恢复时核对冻结候选。未设置保持旧调用兼容，精确旧版本恢复不受新目标限制。不修改候选选择、迁移事务或维护状态机。

## 一次性用户脚本

`docs/operations/main-0226-update.sh APPROVED_MERGED_MAIN_SHA` 由用户保存为独立脚本后 sudo bash 执行，不 source。

1. 核对已安装state目录、phase=completed、active/current=8c2beb55且port3203；保留独立日志。
2. 使用既有dxrework SSH身份完整fetch main，拒绝与用户批准SHA不符；清洁固定检出；随后递归转为Root持有并移除其他用户写权限，在Root执行任何检出代码前再次验证目标SHA、完整git对象及干净状态。
3. 从已安装state读取两项安装参数，不猜Node/nginx路径。校验root持有Node22，dxrework配置Node一致、npm10、pm2路径，PostgreSQL客户端同major且pg_dump不旧于服务端。
4. 以dxrework读取既有配置；只读核对完整0225历史、0226准入权限、数据库备份空间。使用临时依赖链接加载已有pg，退出前解除该临时链接；不打印配置凭据。
5. 只调用main的install-online-entry.sh，两个参数为已核验Node二进制和现有nginx配置。未调用双环境安装器，不安装Acceptance工具。
6. 设置预期SHA后调用固定dx-rework-maintenance-update。工具持发布锁，准备候选和精确旧版恢复包，验证产物和依赖后才进入503维护、排空请求、停旧进程、静默备份、事务迁移、readiness/版本检查、路由切回与receipt提交。
7. 核对active/current/本地与公网版本/ready以及schema0226、活动3203。成功标志MAIN_0226_UPDATE_FINISHED与固定入口MAINTENANCE_RELEASE_SUCCESS须同时出现。

脚本不清理旧发布、候选、备份或业务文件。失败保留logdir、phase、candidate-sha、active/previous-active、backup.log与备份。迁移前失败保持旧服务；迁移事务未提交可按原控制器核对完整旧历史后恢复；已提交后失败保留维护状态，使用同一冻结候选恢复，禁止旧代码强启或数据库覆盖还原。外层一次性脚本故意不重入未完成phase；此时依照固定入口的已有恢复流程处理，不能重新选择其他SHA。

## 验证层级

- 准入测试覆盖0226正确/过期计划、SQL漂移、缺schema/函数/两种语言权限、已迁移无需DDL权限；预期SHA匹配/不符/非法/未指定及旧恢复兼容。
- `tests/fixtures/revision-maintenance-admission.mjs` 在独立标记PostgreSQL16数据库、非超级用户下执行全部225条旧迁移及真实0226 SQL。运行实际Bash维护控制器（路径隔离，nginx/进程/HTTP为模拟探针），覆盖各权限拒绝在切换前、真实DDL失败整笔回滚、提交后启动失败保留维护、错误恢复SHA拒绝、3203同一冻结候选恢复及再次迁移零条。旧225条receipt含时间戳原样保留。
- 复用发布生命周期、依赖bin恢复、部署失败测试；Full Gate执行实际打包、产物依赖/runtime/live/version校验、传输校验，以及隔离数据库备份恢复演练。
- 真实ECS SSH环境、nginx与运行服务、数据库账号权限、磁盘容量仍由用户执行时预检判定。未宣称真实ECS部署已实测。

## 分支边界

release fresh fetch为0e198f0989050d7fd7a400b7a6a9453bde71cbfd/schema0245，0226_digital_production_budgets已占用。后续单独移植服务/测试，按届时最新序号追加对应修复迁移（当前候选0246），不覆盖/改名已应用迁移，不把release模块合入main。若未来跨分支升级需要兼容main已应用0226，另行显式审核历史映射，不能擅自标记迁移已执行。
