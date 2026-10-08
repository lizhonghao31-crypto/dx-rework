# Acceptance PG13 维护兼容修复

范围：验收分支的迁移执行、只读权限预检、工具审计安装与失败恢复。FULL Gate。不会升级数据库或修改业务规则。

## 冻结历史与执行兼容

已合入的 `0236_factory_remainder_executions.sql` 使用 PG15 引入的 `UNIQUE NULLS NOT DISTINCT`。不能从本次更新在工具升级前停止，推断所有保留环境均未应用0236；也不能追加0237让PG13跳过0236的语法错误。

保留所有原 SQL 字节、manifest、权限清单 checksum 和 schema_migrations 记录。`scripts/deploy/migration-execution-compatibility.json` 将唯一一处语句替换绑定到原0236 checksum及完整替代SQL checksum；其它语句不变。此文件属于需要审计安装的受保护策略，没有加入自动工具刷新豁免。

Node迁移器和Acceptance Python3.6生成器共用该绑定规则。只有尚未应用0236且实际服务器为PG13/14时执行替代版本：原厂NULL行唯一(production_order_id,sequence)，转入厂非NULL行唯一(production_order_id,factory_decision_id,sequence)。production_order_id和sequence仍为NOT NULL；两个互斥partial UNIQUE索引与原NULLS NOT DISTINCT约束等价。没有UUID哨兵、普通三列UNIQUE或放宽NULL重复。源码没有该约束名的ON CONFLICT/FK依赖；并发插入由数据库唯一索引执行序列化检查。

PG15/16继续执行原SQL。已应用0236在相同checksum验证后跳过，不修改其约束、SQL/hash、applied_at或任何业务行。新PG13执行记录仍绑定原逻辑迁移指纹；替代执行指纹通过单独已审计工具策略校验，不能接受任意SQL漂移。未知历史、缺口、checksum漂移继续拒绝。

## 旧psql失败关闭

旧psql没有:SHELL_ERROR。两次历史校验改为psql13支持的受控命令输出：先清空变量，只有校验器完成prefix/current检查后输出完整固定成功信号；SQL明确检查整个输出，失败、空值、缺失、其它输出均使ON_ERROR_STOP终止。同时对命令非零退出进行受控失败标记，不能以成功输出掩盖失败退出码。生产及Acceptance历史导出使用同连接三个-c参数（BEGIN READ ONLY、SELECT、COMMIT），避免psql13仅返回多语句-c的最后结果而导出空文件。前后校验仍在原psql连接和session advisory lock内；单项迁移事务、权限预检、备份与失败恢复条件不变。

## 验证与现场边界

正式隔离演练覆盖PG13.23及psql13、Python3.6.15，兼顾PG15/16：混合所有者一次性报告且不写历史；锁竞争拒绝；失败/空/缺失/错误及最终校验信号拒绝；权限清单缺对象回滚；0227及0236事务中断、重试、重复执行；真实唯一索引并发重复拒绝；应用低权限读写；备份及隔离恢复保留业务夹具和历史；Node原生迁移器执行与重复跳过。FULL Gate继续原有门禁，并加入PG13维护演练。

安装必须从独立GitHub完整对象库取得最终固定SHA，核验release祖先、tree、fsck、完整库和干净状态后审计安装。沿现有dxrework身份和SSH路径，不读密钥内容。安装后执行固定SHA diagnose，成功后才update，不做系统包或数据库升级。

隔离夹具及CI证据不等于现场数据库历史导出或线上业务验收。现场diagnose自行验证实际Acceptance身份、历史和权限；任何未知记录或缺权限均停止，不自动变更既有OWNER/ACL。迁移各自提交，失败可能已落地之前的迁移；只有完整历史未变且旧版本之前在线并验证成功才允许恢复旧运行代码。否则保持停止并使用候选向前修复，不承诺自动数据库回滚或零中断。部署由用户负责。
