#!/usr/bin/env bash
set -euo pipefail
umask 077

server_name="${1:-}"
[[ "$server_name" == "staging-api.dxerp.org.cn" ]] || {
  echo 'inspection target must be staging-api.dxerp.org.cn' >&2
  exit 64
}

emit() {
  local key="$1" value="${2:-}"
  value="$(printf '%s' "$value" | tr '\n\r\t' '   ' | sed -E 's#(postgres(ql)?://)[^/@[:space:]]+(:[^/@[:space:]]+)?@#\1[REDACTED]@#g;s#([?&](token|secret|signature|session)=)[^&[:space:]]+#\1[REDACTED]#Ig')"
  printf 'INSPECT %s=%s\n' "$key" "$value"
}

command_status() {
  if command -v "$1" >/dev/null 2>&1; then
    emit "command.$1" present
  else
    emit "command.$1" missing
  fi
}

file_status() {
  local key="$1" path="$2" stat_line
  if [[ -e "$path" || -L "$path" ]]; then
    stat_line="$(stat -Lc '%F|%U|%G|%a' "$path" 2>/dev/null || stat -c '%F|%U|%G|%a' "$path" 2>/dev/null || true)"
    emit "$key" "present|$stat_line"
  else
    emit "$key" missing
  fi
}

list_env_keys() {
  local key="$1" path="$2" keys
  if [[ ! -f "$path" || -L "$path" ]]; then
    emit "$key" unavailable
    return
  fi
  keys="$(awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' "$path" | LC_ALL=C sort -u | paste -sd, -)"
  emit "$key" "$keys"
}

safe_env_value() {
  local file="$1" wanted="$2"
  awk -F= -v wanted="$wanted" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null || true
}

emit_nonsecret_deploy_values() {
  local path="$1" key value
  if [[ ! -f "$path" || -L "$path" ]]; then
    emit deploy.values unavailable
    return
  fi
  for key in \
    DX_REWORK_NODE_BIN \
    DX_REWORK_NGINX_MODE \
    DX_REWORK_SERVER_NAME \
    DX_REWORK_TLS_CERT \
    DX_REWORK_TLS_KEY \
    DX_REWORK_NGINX_CONFIG \
    DX_REWORK_PROFILE; do
    value="$(safe_env_value "$path" "$key")"
    if [[ -n "$value" ]]; then emit "deploy.$key" "$value"; else emit "deploy.$key" absent; fi
  done
}

emit_app_safe_state() {
  local path="$1" base
  if [[ ! -f "$path" || -L "$path" ]]; then
    emit app.safe_state unavailable
    return
  fi
  base="$(safe_env_value "$path" APP_BASE_PATH)"
  emit app.APP_BASE_PATH "${base:-absent}"
  for key in \
    DATABASE_URL \
    DINGTALK_CORP_ID \
    DINGTALK_H5_APP_KEY \
    DINGTALK_H5_APP_SECRET \
    DINGTALK_WEB_CLIENT_ID \
    DINGTALK_WEB_CLIENT_SECRET \
    DINGTALK_QR_REDIRECT_URI \
    SESSION_SECRET \
    OWNER_BOOTSTRAP_DINGTALK_USER_ID \
    OWNER_BOOTSTRAP_SECRET \
    TODO_RUNTIME_ACTOR_ID \
    OSS_ACCESS_KEY_ID \
    OSS_ACCESS_KEY_SECRET; do
    if awk -F= -v wanted="$key" '$1 == wanted { found=1 } END { exit(found ? 0 : 1) }' "$path"; then
      emit "app.key_present.$key" true
    else
      emit "app.key_present.$key" false
    fi
  done
  for key in NODE_ENV HOST PORT SERVICE_NAME TODO_RUNTIME_ENABLED; do
    value="$(safe_env_value "$path" "$key")"
    if [[ -n "$value" ]]; then emit "app.$key" "$value"; else emit "app.$key" absent; fi
  done
}

emit 'inspection.schema' 'pr17-shared-host-v1'
emit inspection.server_name "$server_name"
emit inspection.user "$(id -un)"
emit inspection.uid "$(id -u)"
emit os.uname "$(uname -srvmo 2>/dev/null || uname -a)"
if [[ -r /etc/os-release ]]; then
  os_id="$(awk -F= '$1=="ID"{gsub(/\"/,"",$2);print $2}' /etc/os-release)"
  os_version="$(awk -F= '$1=="VERSION_ID"{gsub(/\"/,"",$2);print $2}' /etc/os-release)"
  emit os.release "${os_id:-unknown}|${os_version:-unknown}"
fi

for command_name in node npm nginx pm2 psql pg_dump pg_restore openssl ss curl python3 sudo; do
  command_status "$command_name"
done

if command -v node >/dev/null 2>&1; then emit node.version "$(node --version 2>/dev/null || true)"; fi
if command -v npm >/dev/null 2>&1; then emit npm.version "$(npm --version 2>/dev/null || true)"; fi
if command -v pm2 >/dev/null 2>&1; then emit pm2.version "$(pm2 --version 2>/dev/null || true)"; fi
if command -v psql >/dev/null 2>&1; then emit psql.version "$(psql --version 2>/dev/null || true)"; fi

for path in \
  /opt/dx-rework \
  /opt/dx-rework/releases \
  /opt/dx-rework/generations \
  /opt/dx-rework/frontend \
  /opt/dx-rework/frontend/releases \
  /opt/dx-rework/shared \
  /opt/dx-rework/logs \
  /opt/dx-rework/backups \
  /opt/dx-rework/evidence \
  /opt/dx-rework/locks \
  /opt/dx-rework/incoming; do
  file_status "path.${path//\//_}" "$path"
done

for link in /opt/dx-rework/active /opt/dx-rework/current /opt/dx-rework/frontend/current; do
  if [[ -L "$link" ]]; then
    emit "link.${link//\//_}" "$(readlink "$link")|resolved=$(readlink -f "$link" 2>/dev/null || true)"
  elif [[ -e "$link" ]]; then
    emit "link.${link//\//_}" 'exists-not-symlink'
  else
    emit "link.${link//\//_}" missing
  fi
done

app_env=/opt/dx-rework/shared/.env
deploy_env=/opt/dx-rework/shared/deploy.env
restore_env=/opt/dx-rework/shared/restore.env
file_status app.env "$app_env"
file_status deploy.env "$deploy_env"
file_status restore.env "$restore_env"
list_env_keys app.env_keys "$app_env"
list_env_keys deploy.env_keys "$deploy_env"
list_env_keys restore.env_keys "$restore_env"
emit_app_safe_state "$app_env"
emit_nonsecret_deploy_values "$deploy_env"

if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -qE ':3201[[:space:]]'; then emit port.3201 listening; else emit port.3201 not-listening; fi
fi

if command -v pm2 >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  pm2_safe="$(pm2 jlist 2>/dev/null | python3 -c '
import json,sys
try:
    apps=json.load(sys.stdin)
except Exception:
    print("unavailable")
    raise SystemExit(0)
out=[]
for app in apps:
    if app.get("name") != "dx-rework-api":
        continue
    env=app.get("pm2_env") or {}
    out.append({
        "name": app.get("name"),
        "status": env.get("status"),
        "cwd": env.get("pm_cwd"),
        "script": env.get("pm_exec_path") or env.get("script"),
        "node_version": env.get("node_version"),
    })
print(json.dumps(out,ensure_ascii=False,separators=(",",":")))
' || true)"
  emit pm2.dx_rework_api "${pm2_safe:-unavailable}"
fi

for endpoint in version health/live health/ready; do
  url="http://127.0.0.1:3201/$endpoint"
  body_file="$(mktemp)"
  code="$(curl -sS --max-time 5 -o "$body_file" -w '%{http_code}' "$url" 2>/dev/null || true)"
  emit "api.$endpoint.http" "${code:-unavailable}"
  if [[ "$endpoint" == version && "$code" == 200 && -s "$body_file" ]] && command -v python3 >/dev/null 2>&1; then
    version_safe="$(python3 - "$body_file" <<'PY' 2>/dev/null || true
import json,sys
try:
    value=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception:
    raise SystemExit(0)
allowed={k:value.get(k) for k in ("service","gitSha","expectedSchemaVersion","schemaVersion","ready") if k in value}
print(json.dumps(allowed,ensure_ascii=False,separators=(",",":")))
PY
)"
    emit api.version.safe "${version_safe:-unparseable}"
  fi
  rm -f "$body_file"
done

if ! command -v nginx >/dev/null 2>&1 || ! command -v sudo >/dev/null 2>&1; then
  emit nginx.inspect unavailable
  exit 0
fi

if sudo -n nginx -t >/dev/null 2>&1; then emit nginx.test pass; else emit nginx.test fail; fi

nginx_dump="$(mktemp)"
trap 'rm -f "$nginx_dump"' EXIT
if ! sudo -n nginx -T >"$nginx_dump" 2>&1; then
  emit nginx.dump unavailable
  exit 0
fi
emit nginx.dump available

python3 - "$nginx_dump" "$server_name" <<'PY'
import json,re,sys
path,target=sys.argv[1:]
text=open(path,encoding="utf-8",errors="replace").read().splitlines()
current_file="unknown"
file_lines={}
for line in text:
    match=re.match(r"^# configuration file (.+):$",line)
    if match:
        current_file=match.group(1)
        file_lines.setdefault(current_file,[])
        continue
    file_lines.setdefault(current_file,[]).append(line)

servers=[]
for filename,lines in file_lines.items():
    depth=0
    active=None
    start_depth=0
    for line in lines:
        stripped=line.split("#",1)[0]
        opens=stripped.count("{")
        closes=stripped.count("}")
        if active is None and re.match(r"^\s*server\s*\{",stripped):
            active=[]
            start_depth=depth
        if active is not None:
            active.append(line)
        depth += opens-closes
        if active is not None and depth==start_depth:
            block=active
            active=None
            names=[]
            for item in block:
                m=re.match(r"^\s*server_name\s+(.+?);\s*$",item.split("#",1)[0])
                if m: names.extend(m.group(1).split())
            if target in names:
                servers.append((filename,block))

def directives(block,pattern):
    out=[]
    rx=re.compile(pattern)
    for raw in block:
        line=raw.split("#",1)[0].strip()
        if rx.search(line): out.append(line)
    return out

files=sorted({filename for filename,_ in servers})
certs=[]; keys=[]; locations=[]; proxies=[]; frontends=[]; maintenance=[]; access=[]; errors=[]
for filename,block in servers:
    for line in directives(block,r"^ssl_certificate\s+"):
        certs.append(line.split(None,1)[1].rstrip(";"))
    for line in directives(block,r"^ssl_certificate_key\s+"):
        keys.append(line.split(None,1)[1].rstrip(";"))
    locations += directives(block,r"^location\s+.*\/rework")
    proxies += directives(block,r"^proxy_pass\s+http://127\.0\.0\.1:3201")
    frontends += directives(block,r"/opt/dx-rework/frontend/current")
    maintenance += directives(block,r"/opt/dx-rework/shared/release-switch\.lock")
    access += directives(block,r"^access_log\s+.*dx_rework_query_free")
    errors += directives(block,r"^error_log\s+/dev/null")

log_formats=[]
for lines in file_lines.values():
    for raw in lines:
        line=raw.split("#",1)[0].strip()
        if re.match(r"^log_format\s+dx_rework_query_free\b",line): log_formats.append(line)

def emit(key,value):
    if isinstance(value,(list,dict)):
        value=json.dumps(value,ensure_ascii=False,separators=(",",":"))
    print(f"INSPECT {key}={value}")

emit("nginx.target_server_count",len(servers))
emit("nginx.target_files",files)
emit("nginx.ssl_certificate_paths",sorted(set(certs)))
emit("nginx.ssl_certificate_key_paths",sorted(set(keys)))
emit("nginx.rework_locations",locations)
emit("nginx.proxy_3201",proxies)
emit("nginx.frontend_directives",frontends)
emit("nginx.maintenance_directives",maintenance)
emit("nginx.query_free_access_directives",access)
emit("nginx.credential_error_log_suppression",errors)
emit("nginx.query_free_log_format_count",len(log_formats))
PY

# Certificate metadata is public information; never read or print private-key contents.
cert_path="$(python3 - "$nginx_dump" "$server_name" <<'PY' 2>/dev/null || true
import re,sys
path,target=sys.argv[1:]
current="unknown"; depth=0; active=None; start=0
for raw in open(path,encoding="utf-8",errors="replace"):
    marker=re.match(r"^# configuration file (.+):$",raw.rstrip("\n"))
    if marker:
        depth=0; active=None
        continue
    line=raw.split("#",1)[0]
    opens=line.count("{"); closes=line.count("}")
    if active is None and re.match(r"^\s*server\s*\{",line): active=[]; start=depth
    if active is not None: active.append(line)
    depth += opens-closes
    if active is not None and depth==start:
        block=active; active=None
        names=[]; certs=[]
        for item in block:
            m=re.match(r"^\s*server_name\s+(.+?);\s*$",item)
            if m: names += m.group(1).split()
            c=re.match(r"^\s*ssl_certificate\s+(.+?);\s*$",item)
            if c: certs.append(c.group(1))
        if target in names and certs:
            print(certs[0]); raise SystemExit
PY
)"
if [[ -n "$cert_path" ]]; then
  file_status nginx.certificate "$cert_path"
  if command -v openssl >/dev/null 2>&1 && [[ -r "$cert_path" ]]; then
    emit nginx.certificate.subject "$(openssl x509 -in "$cert_path" -noout -subject 2>/dev/null || true)"
    emit nginx.certificate.dates "$(openssl x509 -in "$cert_path" -noout -dates 2>/dev/null | paste -sd'|' - || true)"
    if openssl x509 -in "$cert_path" -noout -checkhost "$server_name" >/dev/null 2>&1; then
      emit nginx.certificate.host_match true
    else
      emit nginx.certificate.host_match false
    fi
  fi
fi

emit inspection.result complete
