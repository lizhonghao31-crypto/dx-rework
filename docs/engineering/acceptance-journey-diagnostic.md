# Acceptance journeys 临时分段计时诊断（默认关闭）

用户批准：准备临时诊断、推送PR、Review与正式FULL；最新明确批准以当前release为真实基线，检查通过后合入release。部署和重启由用户执行，助手不访问ECS/生产。

repository: lizhonghao31-crypto/dx-rework
base branch: release/digital-production-v1
base SHA: 93a0d1e08b8bfd4b1e1711b6efe048aaeda7146a
working branch: diagnostic/release-journey-timing-20261105
gate class: FULL
scope: 仅Acceptance journeys列表诊断、测试及原canonical测试映射；不改业务、迁移、依赖、前端或部署策略。

此前基于894b299的隔离候选已完成本地安全复核，4个故障隔离/计数/窗口/文件上界问题已修复；本次保留这些修复，在实际release重新验证。独立目标支持草案未移入本PR，也未修改Actions目标、协议白名单、令牌、代理或平台保护。

## 数据与行为边界

仅 GET `/digital-production/journeys`，不包括详情/导出/其它 workspace。boot 已验证的 Acceptance pool proof 加 test、Acceptance 开关、服务名、127.0.0.1:3202 和 canonical root 限定注册。生产不安装。原认证/Root/权限、候选范围、排序分页、缓存键、SQL 参数、只读事务、错误与时钟冲突语义不变。

默认没有 `/opt/dx-rework-acceptance/shared/journey-diagnostic.json`，不采样、不包装连接池。专属文件必须为当前服务用户拥有的 0600 普通文件，拒绝符号链接/多硬链接/大于512字节/非法JSON/未知字段；读取固定上限513字节并比较前后文件属性，读取或关闭失败均隔离。文件只允许 enabled=true、startedAt、expiresAt，UTC期限最长15分钟；开始和结束采样都重新检查，并以文件设备/inode/ctime和内容绑定原窗口，替换窗口不能恢复旧样本；另有单调时钟截止，系统时钟回拨不延长已观察窗口。每进程累计最多10次、并发最多1次；额外请求正常执行，不排队采样。断连释放名额，不生成不完整记录。删除文件使后续开关检查失败，并抑制尚未提交的在途输出；已经提交到日志管道的记录不能撤回。到期无需重启。首次启用后的驱动包装留在内存，无采样上下文时原样转发；彻底移除需恢复候选/重启。

不增加数据查询、表、授权或HTTP管理入口。不持有新凭据。SQL包装只计实际client.query调用（包括认证、事务控制、失败SQL、事务外clock查询），不重复计Pool.query。缓存命中在原分支单独计数；不是缓存查询数冒充真实数据库调用数。时间包含客户端/网络/解码，不是Postgres纯执行时间。没有SQL文本/参数/异常消息/订单/用户/角色/场景标识或客户端request-id。每请求最多一行固定数字字段和服务端随机sample UUID。stdout使用单条在途、最多4096字节的fs.write；并发/超限记录丢弃，同步和异步写入错误均丢弃，避免stdout流的未处理EPIPE。连接获取和SQL回调显式恢复调用时诊断上下文（包括无上下文），避免排队请求和后台回调错计。不同请求不共享缓存或计数。

阶段：clock_prehandler（含其原认证）、route_auth、pool_acquire、candidates、summary_projection、filter_page、detail_projection、bulk、closure、sla、clock_read、clock_postcheck、serialization_window、sql。ms为累计毫秒，calls为调用次数；candidates是授权候选数，cache_hits是原缓存命中数。未调用阶段calls=0，表示不适用。bulk/closure/sla/clock/sql等为嵌套阶段，不能将全部ms相加。pool_acquire包含可能的新建连接，不全是排队。serialization_window是preSerialization到onSend的框架窗口，不宣称纯JSON stringify耗时。request_ms到onResponse，不等于浏览器TTFB，也不含Nginx前排队/网络。

列表先投影全部授权候选再筛选分页，可能再次投影当页详情；快照释放后还校验clock。SLA监督受原请求scope控制，不能预设每次列表都会执行。计时用performance.now，开关用真实UTC，不用模拟业务时钟。

## 必须先完成的发布条件

1. 核完整diff并形成唯一诊断提交；本地证据不能代替Review/正式FULL。没有40位诊断SHA时不可部署。
2. 逐文件核与release实际基线93a0d1e0差异仅诊断、测试及文档。package/lock、迁移SQL、migration manifest、前端、部署工具未改；本地已核这些字节与基线相同。
3. 核现场实际完整migration ledger/checksum/DB身份/owner/ACL及已安装工具，不只看“0273”。本次没有取得现场证据，不声称兼容性已通过。
4. 用户按现有runbook固定工具执行 `dx-acceptance diagnose <40位诊断SHA>`，通过后 `dx-acceptance update <同SHA>`。这些是已支持入口，但未执行。不能用diagnose结果当接口计时。不要升级到未核release head，不手改dist/版本号，不跳过工具的备份、身份、容量或一致性守卫。
5. 首次安装诊断代码需要Acceptance API更新/短暂重启。API-only源码变化不要求依赖升级；同代前后端来源与manifest一致性仍由原工具证明，不复制旧前端改版本。若工具因完整构建来源要求更多步骤，沿真实工具行为，不能承诺只重启就可部署。

## 用户操作：短期开启（仅部署并验明诊断SHA后）

将下面 `REPLACE_WITH_APPROVED_40_CHAR_DIAGNOSTIC_SHA` 换成已核准诊断SHA。独立Python进程执行，不source，不读取.env、不输出配置/凭据。固定10分钟窗口。由root启动，文件实际由dxacceptance创建。

```bash
runuser -u dxacceptance -- python3 - REPLACE_WITH_APPROVED_40_CHAR_DIAGNOSTIC_SHA <<'PY'
import datetime, json, os, pathlib, re, stat, sys, tempfile
sha = sys.argv[1]
assert re.fullmatch(r'[0-9a-f]{40}', sha), '需要已核准诊断SHA'
root = pathlib.Path('/opt/dx-rework-acceptance')
release = (root / 'current').resolve(strict=True)
assert release == root / 'releases' / sha, '当前不是指定不可变候选'
assert json.loads((release / 'release-manifest.json').read_text())['gitSha'] == sha
folder = root / 'shared'
assert folder.is_dir() and not folder.is_symlink()
path = folder / 'journey-diagnostic.json'
if path.exists() or path.is_symlink():
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
now = datetime.datetime.now(datetime.timezone.utc)
fmt = lambda value: value.isoformat(timespec='seconds').replace('+00:00', 'Z')
config = dict(enabled=True, startedAt=fmt(now), expiresAt=fmt(now + datetime.timedelta(minutes=10)))
fd, temporary = tempfile.mkstemp(prefix='.journey-diagnostic-', dir=str(folder))
try:
    with os.fdopen(fd, 'w') as out:
        json.dump(config, out)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
print('诊断窗口结束时间:', config['expiresAt'])
PY
```

用同一有效UAT身份、原列表/同一筛选条件串行预热一次，再刷新约5次。不要切测试时钟或改业务数据，不做并发压测；浏览器保留TTFB/总时长，不上传HAR/cookie。采样最多10次，不能承诺一定采到本人的请求，避免其它人同时操作。窗口内其它合法列表请求也可能被采到，但输出不包含身份。没有新日志可能是上限、并发、关闭、到期或输出丢弃，不等于请求没发生。

## 用户操作：只提取有界匿名结果

以下最多读取API输出日志末尾1MiB，最多展示10条通过白名单的记录；不输出其它日志、SQL或错误原文。以样本顺序关联单人串行复测，不使用身份关联。

```bash
runuser -u dxacceptance -- python3 - <<'PY'
import json, math, pathlib, re
p = pathlib.Path('/opt/dx-rework-acceptance/logs/api-out.log')
keys = set('clock_prehandler route_auth pool_acquire candidates summary_projection filter_page detail_projection bulk closure sla clock_read clock_postcheck sql serialization_window'.split())
number = lambda v: type(v) in (int, float) and math.isfinite(v) and v >= 0
records = []
with p.open('rb') as f:
    f.seek(0, 2)
    f.seek(max(0, f.tell() - 1048576))
    data = f.read(1048576)
for line in data.decode('utf-8', errors='replace').splitlines():
    if 'JOURNEY_DIAGNOSTIC ' not in line: continue
    try:
        r = json.loads(line.split('JOURNEY_DIAGNOSTIC ', 1)[1])
        assert set(r) == {'version','sample','status','request_ms','ms','calls','candidates','cache_hits'}
        assert r['version'] == 1 and re.fullmatch(r'[0-9a-f-]{36}', r['sample'])
        assert type(r['status']) is int and 100 <= r['status'] <= 599
        assert set(r['ms']) == keys and set(r['calls']) == keys
        assert all(number(v) for v in list(r['ms'].values()) + list(r['calls'].values()) + [r['request_ms'],r['candidates'],r['cache_hits']])
        records.append(r)
    except (ValueError, TypeError, KeyError, AssertionError): pass
for r in records[-10:]: print(json.dumps(r, separators=(',', ':')))
print('有效记录数（最多展示10条）:', min(len(records), 10))
PY
```

记录可能来自同进程此前窗口；同时记下本次窗口时间及复测前后的日志位置/有效样本数，不将旧样本冒充此次测量。PM2默认时间前缀不参与输出。本实现未额外落盘日志；匿名记录按既有日志保留制度留存，不为了结束诊断清空整个日志。

## 用户操作：立即停止与恢复

```bash
runuser -u dxacceptance -- python3 - <<'PY'
import os, pathlib, stat
p = pathlib.Path('/opt/dx-rework-acceptance/shared/journey-diagnostic.json')
if p.exists() or p.is_symlink():
    s = p.lstat()
    assert stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid(), '拒绝异常目标'
    p.unlink()
print('诊断开关已移除；后续检查拒绝采样，已提交的日志无法撤回')
PY
```

启停文件无需重启；关后复测列表应行为相同且无新增诊断行。该命令不停止进程、不删除日志或业务数据。彻底移除代码由父线程准备同基线移除诊断的恢复候选，完成对应验证后用户走既有update入口，需要一次Acceptance更新/重启。也可评估固定旧894b299恢复，但必须先由原工具证明完整ledger/manifest兼容；禁止手工切current、自动回库、删备份或附件。生产3201不操作。

## 本地验证与发布证据

实际工具链为Node22.22.2/npm10.9.9；采用仓库现行预检、canonical单worker和新鲜低权限/带marker的PG16.15隔离库。真实PG验证回调/排队的SQL归属、缓存命中、ROLLBACK、事务外clock及完整schema下真实Journey HTTP采样启停响应一致性。没有使用现场或生产数据。

本次施工记录与准确来源/命令/通过失败及报告摘要见同目录construction-evidence.json；外置实际日志/结构化报告不提交。旧基线测试报告不会冒充本次release的结果。GitHub light、Review和FULL分别在PR记录，不把本地验证当远端通过。

当前Acceptance原版本为894b299/schema0273；本PR相对release没有migration或业务变化，不等于现场完整ledger/checksum/DB身份/owner/ACL已经核实。用户部署前仍须既有工具diagnose；从旧Acceptance更新到最终release候选时，按实际完整差异决定最小动作，不能只看本PR。到期/删除开关无需重启；首次安装或彻底移除代码需要用户按既有更新流程处理。原回滚/备份/附件边界保持。

时间源清单仅刷新diagnostic、journey-query及identity-routes三个条目。原人工semanticReview/evidence保留；诊断Date.now只判定真实UTC采样期限，performance.now计真实耗时，不生成业务发生时间或改变SLA锚点。
