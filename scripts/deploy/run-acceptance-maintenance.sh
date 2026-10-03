#!/usr/bin/env bash
# Called only by the root controller, with root-owned Git files and a verified live identity.
set -Eeuo pipefail
[[ "$(id -u)" == 0 && $# == 2 ]]
mode="$2"
[[ "$mode" == preflight || "$mode" == apply ]]
tool_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
snapshot="$(realpath "$1")"
[[ "$snapshot" == /tmp/dx-acceptance-source.* && "$(stat -c %U "$snapshot")" == root ]]
readarray -t tools < <(python3 - <<'PY'
import os,pathlib,shutil,stat
p=pathlib.Path('/opt/dx-rework-acceptance/shared/deploy.env')
config={}
for line in p.read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key,value=line.split('=',1);config[key]=value
node=config.get('DX_REWORK_NODE_BIN','')
pg=config.get('DX_REWORK_PG_BIN_DIR','')
psql=str(pathlib.Path(pg)/'psql') if pg else shutil.which('psql')
for value in (node,psql):
    if not value or not pathlib.Path(value).is_absolute(): raise SystemExit('Approved maintenance tool unavailable')
    path=pathlib.Path(value).resolve(strict=True)
    for part in (path,*path.parents):
        info=part.stat()
        if info.st_uid!=0 or info.st_mode & 0o022: raise SystemExit('Maintenance tool is not root controlled')
    if not path.is_file() or not os.access(path,os.X_OK): raise SystemExit('Maintenance tool is not executable')
    print(path)
PY
)
[[ "${#tools[@]}" == 2 ]]
node="${tools[0]}"; psql="${tools[1]}"
[[ "$("$node" -p 'process.versions.node.split(".")[0]')" == 22 ]]
[[ "$("$psql" --version)" == *PostgreSQL* ]]
identity="$snapshot/acceptance-identity.json"
port="$(python3 - "$identity" <<'PY'
import json,sys
data=json.load(open(sys.argv[1]))
if data.get('database')!='dx_rework_acceptance' or type(data.get('port')) is not int or not 1<=data['port']<=65535: raise SystemExit('Invalid Acceptance identity')
print(data['port'])
PY
)"
history="$snapshot/maintenance-history.json"
install -o postgres -g postgres -m 0600 /dev/null "$history"
python3 "$tool_root/scripts/deploy/prepare-acceptance-migration.py" "$snapshot" "$identity" "$node" "$history" "$snapshot/maintenance.sql" "$mode" "$tool_root"
chmod 0644 "$snapshot/maintenance.sql"
# Existing local peer-authenticated maintenance route; never use a default port.
# The session immediately drops database superuser authority to the fixed owner.
runuser -u postgres -- env -i PATH=/usr/bin:/bin "$psql" -X --port="$port" --dbname=dx_rework_acceptance --file="$snapshot/maintenance.sql"
