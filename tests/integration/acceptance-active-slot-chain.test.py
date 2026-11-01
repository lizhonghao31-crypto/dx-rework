#!/usr/bin/env python3
"""Offline fixture for the immutable Acceptance controller/worker/verifier chain.

Run: python3 tests/integration/acceptance-active-slot-chain.test.py

All absolute deployment paths are redirected beneath one temporary directory.
The real controller, worker, flow, refresh validator and health reader run.
OS identity, HTTP, git transport, database and PM2 are explicit local doubles.
No privileged commands, remote fetches or external database access are used.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


REPOSITORY = Path(__file__).resolve().parents[2]
REAL_NODE = shutil.which("node")
REAL_PYTHON = sys.executable
REAL_GIT = shutil.which("git")
MAIN_TOOLS = REPOSITORY / "tests/fixtures/main-tools"
SHA0 = "1" * 40
SHA1 = "2" * 40
SHA2 = "3" * 40
SCHEMA = "0001_fixture"


def write(path, content, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = textwrap.dedent(content)
    if content.startswith("#!"):
        first, rest = content.split("\n", 1)
        content = first + "\n" + textwrap.dedent(rest)
    path.write_text(content)
    path.chmod(mode)


def command(args, cwd=None, env=None, check=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True,
                            capture_output=True, timeout=60, start_new_session=True)
    if check and result.returncode:
        raise AssertionError("Command failed: {}\n{}\n{}".format(
            args, result.stdout, result.stderr))
    return result


def fingerprint(root):
    """Include symlink targets, file modes and bytes, never traverse symlinks."""
    result = {}
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(parent) / name
            key = str(path.relative_to(root))
            mode = path.lstat().st_mode & 0o7777
            if path.is_symlink():
                result[key] = ("link", mode, os.readlink(path))
            elif path.is_file():
                result[key] = ("file", mode, hashlib.sha256(path.read_bytes()).hexdigest())
            else:
                result[key] = ("dir", mode)
    return result


class Fixture:
    def __init__(self):
        self.directory = Path(tempfile.mkdtemp(prefix="dx-slot-chain-"))
        self.repo = self.directory / "repo"
        self.runtime = self.directory / "production"
        self.acceptance = self.directory / "acceptance"
        self.state = self.directory / "production-state"
        self.tools = self.directory / "acceptance-tools"
        self.main_tools = self.directory / "main-tools"
        self.launch = self.directory / "launch"
        self.bin = self.directory / "bin"
        self.network = self.directory / "network.json"
        self.trace = self.directory / "trace.jsonl"
        self.tmp = self.directory / "tmp"
        for path in (self.repo, self.runtime, self.acceptance, self.state,
                     self.tools, self.main_tools, self.launch, self.bin, self.tmp):
            path.mkdir(parents=True)
        self.state.chmod(0o700)
        self.mapping = {
            "/opt/dx-rework-acceptance-tools": str(self.tools),
            "/opt/dx-rework-release-tools": str(self.main_tools),
            "/opt/dx-rework-release-state": str(self.state),
            "/opt/dx-rework-acceptance": str(self.acceptance),
            "/opt/dx-rework/source": str(self.repo),
            "/opt/dx-rework": str(self.runtime),
            "/usr/local/bin": str(self.launch),
            "/home/dxacceptance": str(self.directory / 'acceptance-home'),
            "/run/lock": str(self.directory / "lock"),
            "/tmp/dx-acceptance-source.": str(self.tmp / "dx-acceptance-source."),
            "/tmp/dx-g1-compat.": str(self.tmp / "dx-g1-compat."),
            "/tmp/dx-update-git.": str(self.tmp / "dx-update-git."),
            "/tmp/dx-main-update.": str(self.tmp / "dx-main-update."),
            "/tmp/dx-main-git.": str(self.tmp / "dx-main-git."),
            "/etc/nginx": str(self.directory / "nginx"),
        }
        (self.directory / "lock").mkdir()
        self.copy_repository()
        self.make_commands()
        self.env = {"PATH": str(self.bin) + ":/usr/bin:/bin", "HOME": str(self.directory),
                    "LANG": "C", "LC_ALL": "C"}
        self.setup_runtime()
        self.commit_source()

    def mapped(self, content):
        for old, new in self.mapping.items():
            content = content.replace(old, new)
        # Keep the doubles available across the real env -i worker boundary.
        content = content.replace(
            "export PATH=/usr/local/sbin:" + str(self.launch) + ":/usr/sbin:/usr/bin:/sbin:/bin",
            "export PATH=" + str(self.bin) + ":/usr/bin:/bin")
        return content

    def copy_repository(self):
        required = ["scripts/dx-acceptance.sh", "scripts/dx-update.sh",
                    "scripts/deploy/lib.sh", "scripts/deploy/update-acceptance-local.sh",
                    "scripts/deploy/acceptance-update-flow.sh",
                    "scripts/deploy/acceptance-update-policy.mjs",
                    "scripts/deploy/verify-acceptance-update.mjs",
                    "scripts/deploy/verify-tool-refresh.py",
                    "scripts/deploy/production-runtime-health.py",
                    "scripts/deploy/fetch-update-source.sh",
                    "scripts/deploy/inspect-acceptance-identity.sh",
                    "scripts/deploy/inspect-acceptance-storage.py",
                    "scripts/deploy/acceptance-capacity.py",
                    "scripts/deploy/acceptance-runtime-state.mjs",
                    "scripts/deploy/acceptance-pm2-activation.mjs",
                    "scripts/migration-history-policy.mjs", "scripts/migration-branches.json",
                    "scripts/check-main-release-compat.mjs",
                    "docs/operations/g1-acceptance-compat-update.sh"]
        for relative in required:
            source = REPOSITORY / relative
            if not source.is_file():
                raise AssertionError("Required real source is missing: " + str(source))
            write(self.repo / relative, self.mapped(source.read_text()), source.stat().st_mode & 0o777)
        sql = "-- fixture migration, never executed\n"
        checksum = hashlib.sha256(sql.encode()).hexdigest()
        self.manifest = {"migrations": [{"version": SCHEMA, "checksum": checksum}]}
        self.history = {"database": "dx_rework", "migrations": self.manifest["migrations"]}
        write(self.repo / "apps/api/migrations" / (SCHEMA + ".sql"), sql)
        write(self.repo / "apps/api/src/platform/migration-manifest.json", json.dumps(self.manifest) + "\n")
        write(self.repo / "scripts/migration-main-extensions.json", "[]\n")
        write(self.repo / "scripts/migration-branches.json", json.dumps({"main":[],"digital":[]})+"\n")
        write(self.repo / "scripts/deploy/acceptance-migration-requirements.json", "{}\n")
        write(self.repo / "package.json", '{"name":"offline-slot-fixture","private":true}\n')
        write(self.repo / "package-lock.json", '{"name":"offline-slot-fixture","lockfileVersion":3}\n')
        write(self.repo / "infra/pm2/ecosystem.acceptance.config.cjs", self.mapped((REPOSITORY / 'infra/pm2/ecosystem.acceptance.config.cjs').read_text()))
        # The database/exporter boundary is a fixture. The application update
        # worker and the orchestration/failure routing above it remain real.
        write(self.repo / "scripts/deploy/export-production-history.sh", "#!/bin/sh\nprintf '%s\\n' '" + json.dumps(self.history) + "'\n", 0o755)
        write(self.repo / "scripts/deploy/run-acceptance-maintenance.sh", """
            #!/usr/bin/env bash
            set -euo pipefail
            printf '{"kind":"maintenance","action":"%%s"}\\n' "$2" >> '%s'
        """ % self.trace, 0o755)

    def make_commands(self):
        # All wrappers use embedded fixture paths, so clearing env is harmless.
        write(self.bin / "id", """#!/usr/bin/env bash
            case "$1" in -u) echo 0;; -un) echo "${USER:-root}";; *) exit 99;; esac
        """, 0o755)
        write(self.bin / "stat", """#!/usr/bin/env bash
            if [[ "$1" == -c && ( "$2" == %%U || "$2" == %%u ) ]]; then
              if [[ "$2" == %%u ]]; then echo 0;
              elif [[ "$3" == '%s/'* ]]; then echo dxacceptance;
              elif [[ "$3" == '%s/shared/'* ]]; then echo dxrework;
              else echo root; fi
            elif [[ "$1" == -c && "$2" == %%a && "$3" == /tmp ]]; then echo 755;
            else exec /usr/bin/stat "$@"; fi
        """ % (self.acceptance,self.runtime), 0o755)
        write(self.bin / "chown", "#!/bin/sh\nexit 0\n", 0o755)
        write(self.bin / "mv", """#!/usr/bin/env bash
            set -euo pipefail
            source="${@: -2:1}";target="${@: -1}"
            if [[ "$target" == '%s/dx-rework-update' && "$source" == '%s/.dx-rework-update.'* && "$source" != *.restore.* && -f '%s/fail-second-entry' ]]; then
              rm -f '%s/fail-second-entry'
              echo 'Fixture: second Acceptance launcher move failed' >&2
              exit 43
            fi
            exec /usr/bin/mv "$@"
        """ % (self.launch,self.launch,self.directory,self.directory),0o755)
        write(self.bin / "install", """#!/usr/bin/env bash
            set -euo pipefail
            args=()
            while (( $# )); do
              case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac
            done
            exec /usr/bin/install "${args[@]}"
        """, 0o755)
        write(self.bin / "runuser", """#!/usr/bin/env bash
            set -euo pipefail
            user="$2"; shift 3
            export USER="$user"
            exec "$@"
        """, 0o755)
        write(self.bin / "nginx", """#!/usr/bin/env bash
            set -euo pipefail
            printf '{"kind":"nginx","args":"%%s"}\\n' "$*" >> '%s'
            [[ "$*" == -t || "$*" == '-s reload' ]]
        """ % self.trace, 0o755)
        # A local git repository supplies all objects; no SSH program is used.
        write(self.bin / "git", """#!/usr/bin/env python3
            import subprocess,sys,json
            args=sys.argv[1:]
            with open(%r,'a') as f:f.write(json.dumps({'kind':'git','args':args})+'\\n')
            if 'remote' in args and 'get-url' in args:
                print('git@github.com:lizhonghao31-crypto/dx-rework.git');sys.exit(0)
            if 'remote' in args and 'add' in args:
                args=[%r if x=='git@github.com:lizhonghao31-crypto/dx-rework.git' else x for x in args]
            sys.exit(subprocess.call([%r]+args))
        """ % (str(self.trace), str(self.repo), REAL_GIT), 0o755)
        self.make_http_commands()
        self.make_python_command()
        self.make_node_command()
        write(self.bin / "npm", """#!/usr/bin/env bash
            [[ "$*" == --version ]] && { echo 10.0.0; exit 0; }
            echo 'Unexpected fixture build/npm action' >&2; exit 98
        """, 0o755)
        write(self.bin / "pm2", """#!/usr/bin/env python3
            import json,sys,pathlib,os,signal
            root=pathlib.Path(%r);args=sys.argv[1:]
            with open(%r,'a') as f:f.write(json.dumps({'kind':'pm2','args':args,'home':os.environ.get('PM2_HOME')})+'\\n')
            file=root.parent/'network.json';model=json.loads(file.read_text())
            def process():
                sha=model.get('acceptancePm2Sha',%r);release=str(root/'releases'/sha)
                return {'name':'dx-rework-acceptance-api','pm_id':model.get('acceptancePm2Id',0),'pid':4242 if model.get('acceptancePm2Status','online')=='online' else 0,'pm2_env':{'name':'dx-rework-acceptance-api','status':model.get('acceptancePm2Status','online'),'pm_cwd':release,'pm_exec_path':release+'/scripts/deploy/start-acceptance-api.sh'}}
            if args==['jlist']:
                print(json.dumps([process()] if model.get('acceptancePm2Present',True) else []))
            elif args and args[0]=='delete':
                if args[1]!=str(model.get('acceptancePm2Id',0)) or model.get('acceptancePm2Status','online')!='stopped':sys.exit('Only the stopped Acceptance ID can be deleted')
                model['acceptancePm2Present']=False;file.write_text(json.dumps(model))
                if (root.parent/'kill-after-pm2-delete').exists():
                    (root.parent/'kill-after-pm2-delete').unlink();os.killpg(os.getpgrp(),signal.SIGKILL)
            elif args and args[0] in ('startOrReload','stop'):
                if 'dx-rework-acceptance-api' not in args and not (args[0]=='stop' and args[1]==str(model.get('acceptancePm2Id',0))):sys.exit('Production process action is forbidden')
                if args[0]=='startOrReload':
                    if (root.parent/'fail-pm2-start-once').exists() and args[1].endswith('.cjs'):
                        (root.parent/'fail-pm2-start-once').unlink();sys.exit('TEST PM2 start failed')
                    config=json.loads(pathlib.Path(args[1]).read_text())['apps'][0] if args[1].endswith('.json') else None
                    if not model.get('acceptancePm2Present',True):
                        model['acceptancePm2Sha']=os.environ.get('DX_REWORK_ACCEPTANCE_RELEASE_SHA') or (pathlib.Path(config['cwd']).name if config else pathlib.Path(args[1]).parents[2].name)
                        model['acceptancePm2Id']=model.get('acceptancePm2Id',0)+1
                    model['acceptancePm2Present']=True
                    model['acceptancePm2Status']='stopped' if config and config.get('autostart') is False else 'online'
                    model['3202']['version']=json.loads((root/'releases'/model.get('acceptancePm2Sha','1111111111111111111111111111111111111111')/'release-manifest.json').read_text())
                else:model['acceptancePm2Status']='stopped'
                file.write_text(json.dumps(model))
                if args[0]=='startOrReload' and (root.parent/'kill-after-pm2-start').exists():
                    (root.parent/'kill-after-pm2-start').unlink();os.killpg(os.getpgrp(),signal.SIGKILL)
            elif args==['save']:
                if model.get('acceptancePm2Status','online')=='stopped':
                    model['stopSaveCount']=model.get('stopSaveCount',0)+1;file.write_text(json.dumps(model))
                    if (root.parent/'fail-pm2-stop-save').exists() or ((root.parent/'fail-pm2-stop-backup-save').exists() and model['stopSaveCount']==2):sys.exit('TEST stopped save failure')
                if (root.parent/'fail-pm2-save').exists() and model.get('acceptancePm2Status','online')=='online':
                    if (root.parent/'fail-evidence-copy-on-save').exists():(root.parent/'fail-evidence-copy').write_text('TEST evidence allocation failed')
                    sys.exit('TEST PM2 save failure')
                target=root.parent/'acceptance-home/.pm2/dump.pm2';target.parent.mkdir(parents=True,exist_ok=True)
                if target.exists():target.with_name('dump.pm2.bak').write_bytes(target.read_bytes())
                target.write_text(json.dumps([process()]))
            else:sys.exit('Unexpected PM2 action')
        """ % (str(self.acceptance), str(self.trace), SHA0), 0o755)
        for name in ("psql", "pg_dump", "pg_restore"):
            write(self.bin / name, """#!/usr/bin/env python3
                import json,sys,os
                args=' '.join(sys.argv[1:])
                readonly='default_transaction_read_only=on' in os.environ.get('PGOPTIONS','')
                metadata=readonly and ("'storageRole',current_user" in args or "'sessionRole',session_user" in args or args.endswith('select current_database()'))
                with open(%r,'a') as f:f.write(json.dumps({'kind':'capacity-metadata' if metadata else 'database','args':sys.argv[1:],'readonly':readonly})+'\\n')
                if "'storageRole',current_user" in args:print(%r)
                elif 'pg_database_size' in args:print('1024')
                elif 'current_database()' in args and 'json_build_object' not in args:print('dx_rework_acceptance')
                elif 'json_build_object' in args and "'migrations'" in args:print(%r)
                elif 'json_build_object' in args and "'oid'" in args:print('{"database":"dx_rework_acceptance","port":5432,"oid":42,"address":"127.0.0.1","role":"dx_rework_acceptance_app","sessionRole":"dx_rework_acceptance_app"}')
                elif '--version' in args:print('PostgreSQL 16.0')
            """ % (str(self.trace), json.dumps({'database':'dx_rework_acceptance','port':5432,'oid':42,'storageRole':'postgres','serverVersion':130023,'databaseBytes':1024,'maxWalBytes':1048576,'dataDirectory':str(self.directory/'pgdata'),'directoryPaths':['base/42'],'logDirectory':'log'}), json.dumps({"database": "dx_rework_acceptance", "migrations": self.manifest["migrations"]})), 0o755)

    def make_http_commands(self):
        # Shared response model: refusal, readiness/version mismatch and assets.
        self.http_module = self.directory / "http_fixture.py"
        write(self.http_module, """
            import json,pathlib,urllib.parse
            ROOT=pathlib.Path(%r)
            def resolve(url):
                model=json.loads((ROOT/'network.json').read_text())
                with (ROOT/'trace.jsonl').open('a') as f:f.write(json.dumps({'kind':'http','url':url})+'\\n')
                parsed=urllib.parse.urlparse(url)
                if parsed.hostname=='127.0.0.1':
                    port=parsed.port;slot=model.get(str(port))
                    if slot is None:raise ConnectionRefusedError(111,'fixture connection refused')
                    if parsed.path=='/health/ready':return slot.get('health',200),b'{"status":"ready"}'
                    if parsed.path=='/version':return 200,json.dumps(slot['version']).encode()
                if parsed.hostname=='staging-api.dxerp.org.cn':
                    slot=model['3202']; candidate=pathlib.Path(model['acceptanceCandidate'])
                    if parsed.path=='/acceptance/api/health/ready':return 200,b'{"status":"ready"}'
                    if parsed.path=='/acceptance/api/version':return 200,json.dumps(slot['version']).encode()
                    if parsed.path.startswith('/acceptance/'):
                        return 200,(candidate/'frontend'/parsed.path[len('/acceptance/'):]).read_bytes()
                if parsed.hostname=='dxerp.org.cn' and parsed.path=='/version':
                    target=(ROOT/'nginx/site.conf').resolve().stem
                    for key in ('3201','3203'):
                        slot=model.get(key)
                        if slot and slot['version']['gitSha']==target:return 200,json.dumps(slot['version']).encode()
                    state=json.loads((ROOT/'production-state/active.json').read_text())
                    return 200,json.dumps(model[str(state['port'])]['version']).encode()
                raise AssertionError('External/unknown HTTP endpoint forbidden: '+url)
        """ % str(self.directory))
        write(self.bin / "curl", """#!/usr/bin/env python3
            import sys
            sys.path.insert(0,%r)
            from http_fixture import resolve
            url=sys.argv[-1]
            try:status,body=resolve(url)
            except ConnectionRefusedError:sys.exit(7)
            if status<200 or status>=300:sys.exit(22)
            if any('I' in a and a.startswith('-') for a in sys.argv[1:]):
                print('HTTP/1.1 200 OK\\r\\nX-Dx-Release-Protocol: 2\\r\\n')
            else:sys.stdout.buffer.write(body)
        """ % str(self.directory), 0o755)

    def make_python_command(self):
        # Root ownership is unavailable in normal CI. The public Python test
        # seam supplies our real UID; modes, file and symlink checks stay real.
        wrapper = self.directory / "run_python.py"
        write(wrapper, """
            import io,json,os,pathlib,runpy,sys,urllib.error,urllib.request,importlib.util
            sys.dont_write_bytecode=True
            sys.path.insert(0,%r)
            from http_fixture import resolve
            root=%r
            class Response(io.BytesIO):
                def __init__(self,status,data):super().__init__(data);self.status=status;self.code=status;self.headers={}
                def getcode(self):return self.status
            def urlopen(request,*args,**kwargs):
                url=request.full_url if hasattr(request,'full_url') else request
                try:status,data=resolve(url)
                except ConnectionRefusedError as error:raise urllib.error.URLError(error)
                if status>=400:raise urllib.error.HTTPError(url,status,'fixture',{},None)
                return Response(status,data)
            urllib.request.urlopen=urlopen
            urllib.request.OpenerDirector.open=lambda self,request,*args,**kwargs:urlopen(request,*args,**kwargs)
            file=sys.argv[1];sys.argv=sys.argv[1:]
            if file=='-':exec(compile(sys.stdin.read(),'<stdin>','exec'))
            elif file=='-c':exec(sys.argv[1])
            elif file.endswith('/production-runtime-health.py'):
                spec=importlib.util.spec_from_file_location('production_guard',file)
                module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                try:module.main(sys.argv[1:],owner_uid=os.getuid())
                except (module.GuardError,OSError,ValueError,urllib.error.URLError) as error:
                    sys.exit('PRODUCTION_HEALTH_GUARD_FAILED: '+str(error))
            elif file.endswith('/acceptance-capacity.py') or file.endswith('/inspect-acceptance-storage.py'):
                spec=importlib.util.spec_from_file_location('capacity_fixture',file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                if file.endswith('/acceptance-capacity.py'):
                    phase=sys.argv[1]
                    with open(root+'/trace.jsonl','a') as f:f.write(json.dumps({'kind':'capacity','phase':phase})+'\\n')
                    state=pathlib.Path(root)/'capacity-state.json';model=json.loads(state.read_text()) if state.exists() else {}
                    def probe(path):return {'device':'fixture-volume','probe':str(path),'available':0 if model.get('failPhase')==phase else 100*1024**3,'total':200*1024**3}
                    sys.exit(module.main(sys.argv[1:],probe=probe))
                else:module.main(sys.argv[1:],owner_uid=os.getuid(),psql=root+'/bin/psql')
            else:runpy.run_path(file,run_name='__main__')
        """ % (str(self.directory), str(self.directory)))
        write(self.bin / "python3", "#!/bin/sh\nexec " + REAL_PYTHON + " " + str(wrapper) + ' "$@"\n', 0o755)

    def make_node_command(self):
        preload = self.directory / "node-preload.cjs"
        write(preload, """
            const fs=require('node:fs');const path=require('node:path');
            const root=%s;
            global.fetch=async function(input){
              const url=String(input),u=new URL(url),model=JSON.parse(fs.readFileSync(path.join(root,'network.json')));
              fs.appendFileSync(path.join(root,'trace.jsonl'),JSON.stringify({kind:'node-fetch',url})+'\\n');
              let status=200,data;
              if(u.hostname==='127.0.0.1'){
                const slot=model[u.port];if(!slot)throw Error('fixture connection refused');
                if(u.pathname==='/health/ready'){status=slot.health??200;data='{"status":"ready"}';}
                else if(u.pathname==='/version')data=JSON.stringify(slot.version);
              }else if(u.hostname==='staging-api.dxerp.org.cn'){
                if(u.pathname==='/acceptance/api/health/ready')data='{"status":"ready"}';
                else if(u.pathname==='/acceptance/api/version')data=JSON.stringify(model['3202'].version);
                else if(u.pathname.startsWith('/acceptance/'))data=fs.readFileSync(path.join(model.acceptanceCandidate,'frontend',u.pathname.slice('/acceptance/'.length)));
              }
              if(data===undefined)throw Error('External/unknown fetch forbidden: '+url);
              return new Response(data,{status});
            };
        """ % json.dumps(str(self.directory)))
        write(self.bin / "node", """#!/usr/bin/env bash
            set -euo pipefail
            if [[ "$*" == '-p process.versions.node.split(".")[0]' ]]; then echo 22;exit 0; fi
            if [[ "${1:-}" == */database-state.mjs ]]; then
              printf '{"kind":"database-state","action":"%%s"}\\n' "${2:-}" >> '%s'
              if [[ "${2:-}" == export-history ]]; then printf '%%s\\n' '%s'; fi
              if [[ "${2:-}" == print-current ]]; then printf '{"count":1,"version":"%s","checksum":"fixture"}\\n'; fi
              exit 0
            fi
            if [[ "${1:-}" == */check-migration-export.mjs || "${1:-}" == */verify-database-readiness.mjs ]]; then exit 0;fi
            if [[ "${1:-}" == */render-online-nginx.mjs ]]; then printf 'fixture nginx\\n' > "$3";exit 0;fi
            if [[ "${1:-}" == */nginx-workers.mjs ]]; then echo '[]';exit 0;fi
            if [[ "${1:-}" == */drain-nginx-workers.mjs ]]; then exit 0;fi
            exec '%s' --require '%s' "$@"
        """ % (self.trace, json.dumps({"database": "dx_rework_acceptance", "migrations": self.manifest["migrations"]}), SCHEMA, REAL_NODE, preload), 0o755)

    def release(self, root, sha, acceptance=False):
        version = {"gitSha": sha, "schemaVersion": SCHEMA,
                   "schemaChecksum": "fixture", "releaseProtocol": 2,
                   "appBasePath": "/acceptance/" if acceptance else "/"}
        api, frontend = root / "api", root / "frontend"
        write(api / "release-manifest.json", json.dumps(version) + "\n")
        write(frontend / "release-manifest.json", json.dumps(version) + "\n")
        write(frontend / "index.html", '<html><script src="/acceptance/assets/fixture.js"></script></html>\n')
        write(frontend / "assets/fixture.js", "console.log('offline fixture')\n")
        write(api / "apps/api/src/platform/migration-manifest.json", json.dumps(self.manifest) + "\n")
        for script in ("database-state.mjs", "verify-database-readiness.mjs"):
            write(api / "scripts/deploy" / script, "// fixture data boundary\n")
        write(api / "scripts/check-migration-export.mjs", "// fixture data boundary\n")
        write(api / "scripts/deploy/verify-runtime.sh", "#!/bin/sh\nexit 0\n", 0o755)
        write(api / "scripts/backup-postgres.sh", "#!/bin/sh\nprintf '%s\\n' '{\"kind\":\"backup\"}' >> '" + str(self.trace) + "'\necho FIXTURE_BACKUP_ONLY\n", 0o755)
        write(api / "scripts/deploy/install-release.sh", """#!/usr/bin/env bash
            set -euo pipefail
            root='%s';sha="$1";candidate="$2"
            cp -a "$candidate/api" "$root/releases/$sha"
            cp -a "$candidate/frontend" "$root/frontend/releases/$sha"
        """ % self.acceptance, 0o755)
        for config in ("ecosystem.config.cjs", "ecosystem.acceptance.config.cjs"):
            write(api / "infra/pm2" / config, "module.exports={}\n")
        if acceptance:
            write(api / "infra/pm2/ecosystem.acceptance.config.cjs", (self.repo / "infra/pm2/ecosystem.acceptance.config.cjs").read_text())
        write(root / "build-provenance.json", json.dumps({"sourceSha": sha, "frontendSourceSha": sha, "frontendBuilt": True}) + "\n")
        for directory in (api, frontend, root):
            rows=[]
            for file in sorted(directory.rglob("*")):
                if file.is_file() and file.name != "SHA256SUMS":
                    rows.append(hashlib.sha256(file.read_bytes()).hexdigest() + "  " + str(file.relative_to(directory)))
            write(directory / "SHA256SUMS", "\n".join(rows) + "\n")
        return version

    def setup_runtime(self):
        for root in (self.runtime, self.acceptance):
            for name in ("shared", "logs", "releases", "frontend/releases", "generations", "locks", "candidates", "build"):
                (root / name).mkdir(parents=True, exist_ok=True)
            write(root / "locks/release.lock", "")
            old = root / "candidates" / SHA0
            self.release(old, SHA0, root == self.acceptance)
            shutil.copytree(old / "api", root / "releases" / SHA0)
            shutil.copytree(old / "frontend", root / "frontend/releases" / SHA0)
            generation = root / "generations" / SHA0
            generation.mkdir()
            (generation / "api").symlink_to(root / "releases" / SHA0)
            (generation / "frontend").symlink_to(root / "frontend/releases" / SHA0)
            (root / "active").symlink_to(generation)
            (root / "current").symlink_to(root / "active/api")
            (root / "frontend/current").symlink_to(root / "active/frontend")
            write(root / "current/node_modules/unchanged", "production dependency marker\n")
        write(self.acceptance / "shared/.env", """
            DATABASE_URL=postgresql://fixture.invalid/dx_rework_acceptance
            APP_BASE_PATH=/acceptance/
            ROOT_DINGTALK_USER_ID=uat-root
            ACCEPTANCE_LAB_ENABLED=true
            DIGITAL_PRODUCTION_ENABLED=true
            DIGITAL_PRODUCTION_CREATION_ENABLED=true
        """, 0o600)
        write(self.acceptance / "shared/deploy.env",
              "DX_REWORK_NODE_BIN=" + str(self.bin / "node") + "\nDX_REWORK_PG_BIN_DIR=" + str(self.bin) + "\n", 0o600)
        write(self.runtime / "shared/deploy.env", "DX_REWORK_NODE_BIN=" + str(self.bin / "node") + "\n", 0o600)
        self.set_production(SHA0, 3201)
        write(self.state / "node-binary", str(self.bin / "node") + "\n")
        config = self.directory / "nginx/site.conf"
        write(self.state / (SHA0 + ".conf"), "proxy_pass http://127.0.0.1:3201;\n")
        config.parent.mkdir()
        config.symlink_to(self.state / (SHA0 + ".conf"))
        write(self.state / "nginx-config", str(config) + "\n")
        write(self.state / "nginx-template.conf", "proxy_pass http://127.0.0.1:3201;\n")
        write(self.state / "original-deploy-entry", "fixture original launcher\n")
        write(self.launch / "dx-rework-deploy", "#!/bin/sh\necho MAIN_LAUNCHER_UNCHANGED\n", 0o755)
        write(self.launch / "dx-rework-maintenance-update", "#!/bin/sh\nexit 98\n", 0o755)
        release = str(self.acceptance / 'releases' / SHA0)
        write(self.directory / 'acceptance-home/.pm2/pm2.pid', str(os.getpid())+'\n',0o600)
        write(self.directory / 'acceptance-home/.pm2/dump.pm2', json.dumps([
            {'name':'dx-rework-acceptance-api','pm2_env':{'status':'online',
             'pm_cwd':release,'pm_exec_path':release+'/scripts/deploy/start-acceptance-api.sh'}}]))

    def set_production(self, sha, port, phase="completed", health=200):
        write(self.state / "active.json", json.dumps({"sha": sha, "port": port}) + "\n", 0o600)
        write(self.state / "phase", phase + "\n", 0o600)
        model = json.loads(self.network.read_text()) if self.network.exists() else {}
        model.pop("3201", None); model.pop("3203", None)
        model[str(port)] = {"health": health, "version": {"gitSha": sha, "schemaVersion": SCHEMA}}
        model.setdefault("3202", {"version": {"gitSha": SHA0, "schemaVersion": SCHEMA}})
        write(self.network, json.dumps(model) + "\n")

    def commit_source(self):
        command([REAL_GIT, "init", "-q", str(self.repo)])
        command([REAL_GIT, "-C", str(self.repo), "config", "user.name", "Offline Fixture"])
        command([REAL_GIT, "-C", str(self.repo), "config", "user.email", "fixture@example.invalid"])
        command([REAL_GIT, "-C", str(self.repo), "add", "."])
        command([REAL_GIT, "-C", str(self.repo), "commit", "-qm", "New audited tool fixture"])
        self.sha = command([REAL_GIT, "-C", str(self.repo), "rev-parse", "HEAD"]).stdout.strip()
        command([REAL_GIT, "-C", str(self.repo), "branch", "release/digital-production-v1"])
        command([REAL_GIT, "-C", str(self.repo), "branch", "main"])
        command([REAL_GIT, "-C", str(self.repo), "remote", "add", "origin", str(self.repo)])
        command([REAL_GIT, "-C", str(self.repo), "fetch", "-q", "origin", "refs/heads/release/digital-production-v1:refs/remotes/origin/release/digital-production-v1"])
        self.candidate = self.acceptance / "candidates" / self.sha
        version = self.release(self.candidate, self.sha, True)
        model=json.loads(self.network.read_text())
        model["acceptanceCandidate"]=str(self.candidate)
        # All local/public Acceptance endpoints represent the candidate once
        # its fixture service is activated, including the public asset bytes.
        # Current local version changes only on the PM2 activation boundary.
        write(self.network, json.dumps(model) + "\n")

    def run(self, *args, check=True):
        return command(["bash"] + list(map(str, args)), env=self.env, check=check)

    def install(self, check=True):
        return self.run(self.repo / "scripts/dx-acceptance.sh", "install",check=check)

    def update(self, check=True):
        return self.run(self.launch / "dx-rework-update", "acceptance", check=check)

    def production_fingerprint(self):
        return {"state": fingerprint(self.state), "runtime": fingerprint(self.runtime),
                "main-tools": fingerprint(self.main_tools),
                "slot-model": {key:value for key,value in json.loads(self.network.read_text()).items() if key in ('3201','3203')},
                "main-launcher": (self.launch / "dx-rework-deploy").read_bytes(),
                "maintenance-launcher": (self.launch / "dx-rework-maintenance-update").read_bytes(),
                "nginx": fingerprint(self.directory / "nginx")}

    def calls(self):
        return [json.loads(line) for line in self.trace.read_text().splitlines()] if self.trace.exists() else []

    def old_fixed_tools(self):
        old=self.tools / SHA0
        shutil.copytree(self.repo,old,ignore=shutil.ignore_patterns('.git'))
        baseline=REPOSITORY / 'tests/fixtures/acceptance-controller-before-active-slots.sh'
        write(old/'scripts/dx-acceptance.sh',self.mapped(baseline.read_text()),0o755)
        fetch_baseline=REPOSITORY / 'tests/fixtures/acceptance-fetch-before-capacity.sh'
        write(old/'scripts/deploy/fetch-update-source.sh',self.mapped(fetch_baseline.read_text()),0o755)
        (old/'scripts/deploy/production-runtime-health.py').unlink()
        write(old/'TOOL_SHA',SHA0+'\n')
        write(self.launch/'dx-acceptance','#!/usr/bin/env bash\nexec bash '+str(old/'scripts/dx-acceptance.sh')+' "$@"\n',0o755)
        write(self.launch/'dx-rework-update','#!/usr/bin/env bash\nexec bash '+str(old/'scripts/dx-update.sh')+' "$@"\n',0o755)

    def setup_main_controller(self):
        """Run the unchanged main controller and real candidate preparation.

        The candidates are already checksum-registered, so this chain exercises
        prepare validation/registration and slot activation, not npm compilation.
        Compilation/reuse has its own two-round dependency fixture.
        """
        kernel=self.main_tools / ('a'*40)
        for name in ('lib.sh','update-main-online.sh','prepare-online-candidate.sh'):
            file=MAIN_TOOLS/'scripts/deploy'/name
            if not file.is_file():raise AssertionError('Missing frozen main fixture: '+str(file))
            write(kernel/'scripts/deploy'/name,self.mapped(file.read_text()),0o755)
        write(kernel/'scripts/deploy/install-release.sh',"""#!/usr/bin/env bash
            set -euo pipefail
            root='%s';sha="$1";candidate="$2"
            [[ "$3" == register-only ]]
            [[ ! -e "$root/releases/$sha" && ! -e "$root/frontend/releases/$sha" ]]
            cp -a "$candidate/api" "$root/releases/$sha"
            cp -a "$candidate/frontend" "$root/frontend/releases/$sha"
            printf '{"kind":"main-prepare","sha":"%%s"}\\n' "$sha" >> '%s'
        """ % (self.runtime,self.trace),0o755)
        write(kernel/'scripts/deploy/start-online-slot.sh',"""#!/usr/bin/env python3
            import json,pathlib,sys
            root=pathlib.Path(%r);action,sha,port=sys.argv[1:]
            file=root.parent/'network.json';model=json.loads(file.read_text())
            with open(%r,'a') as stream:stream.write(json.dumps({'kind':'main-slot','action':action,'sha':sha,'port':int(port)})+'\\n')
            if action=='start':model[port]={'health':200,'version':{'gitSha':sha,'schemaVersion':%r}}
            elif action=='stop':model.pop(port,None)
            else:raise AssertionError('Invalid slot action')
            file.write_text(json.dumps(model))
        """ % (str(self.runtime),str(self.trace),SCHEMA),0o755)
        # Main dispatch invokes bash scripts, so give that double a shell entry.
        process=kernel/'scripts/deploy/start-online-slot.sh'
        process.rename(kernel/'scripts/deploy/start-online-slot.py')
        write(process,'#!/bin/sh\nexec '+REAL_PYTHON+' '+str(kernel/'scripts/deploy/start-online-slot.py')+' "$@"\n',0o755)
        write(kernel/'scripts/deploy/commit-online-generation.sh',"""#!/usr/bin/env bash
            set -euo pipefail
            source "$(dirname "$0")/lib.sh"
            generation="$(ensure_generation "$1")"
            ensure_active_aliases
            atomic_link "$generation" "$DX_ROOT/active"
        """,0o755)
        write(kernel/'scripts/deploy/save-online-processes.sh','#!/bin/sh\nexit 0\n',0o755)
        write(self.launch/'dx-rework-deploy','#!/usr/bin/env bash\nexec bash '+str(kernel/'scripts/deploy/update-main-online.sh')+' "$@"\n',0o755)
        write(self.runtime/'shared/.env','DATABASE_URL=postgresql://fixture.invalid/dx_rework\nAPP_BASE_PATH=/\n',0o600)
        write(self.runtime/'shared/deploy.env','DX_REWORK_NODE_BIN='+str(self.bin/'node')+'\n',0o600)
        command([REAL_GIT,'-C',str(self.repo),'branch','-f','main'])

    def next_main(self, label):
        command([REAL_GIT,'-C',str(self.repo),'checkout','-q','main'])
        write(self.repo/'apps/main-fixture-label',label+'\n')
        command([REAL_GIT,'-C',str(self.repo),'add','apps/main-fixture-label'])
        command([REAL_GIT,'-C',str(self.repo),'commit','-qm',label])
        sha=command([REAL_GIT,'-C',str(self.repo),'rev-parse','HEAD']).stdout.strip()
        self.release(self.runtime/'candidates'/sha,sha)
        return sha

    def main_update(self):
        return self.run(self.launch/'dx-rework-update','main')

    def close(self):
        shutil.rmtree(self.directory)


class ActiveSlotChainTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()

    def tearDown(self):
        self.fixture.close()

    def test_install_and_repeated_acceptance_updates_follow_both_production_slots(self):
        f=self.fixture
        before=f.production_fingerprint()
        f.install()
        self.assertEqual(before,f.production_fingerprint(),"Explicit tool install changed production")
        for port,sha in ((3203,SHA1),(3201,SHA2)):
            f.set_production(sha,port)
            before=f.production_fingerprint()
            result=f.update()
            self.assertIn("ACCEPTANCE_UPDATE_FINISHED",result.stdout)
            self.assertEqual(before,f.production_fingerprint(),"Acceptance update changed production")
            self.assertIn(str(port),result.stdout)
            verified=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"status":"verified"')]
            self.assertTrue(verified,'Real worker verification result was not returned')
            self.assertEqual(port,verified[-1]['production_port'])
            self.assertEqual(sha,verified[-1]['production_sha'])
        calls=f.calls()
        self.assertTrue(any(x['kind']=='node-fetch' for x in calls),"Real JS verifier did not run")
        self.assertTrue(any(x['kind']=='http' and ':3203/version' in x['url'] for x in calls))
        self.assertTrue(any(x['kind']=='http' and ':3201/version' in x['url'] for x in calls))
        self.assertFalse(any(x['kind']=='nginx' and x['args']=='-s reload' for x in calls))

    def test_unhealthy_or_unstable_production_is_rejected_before_worker(self):
        f=self.fixture;f.install()
        for phase,health in (("prepared",200),("switching",200),("rolling-back",200),("completed",503)):
            with self.subTest(phase=phase,health=health):
                f.set_production(SHA1,3203,phase,health)
                before=f.production_fingerprint();f.trace.unlink(missing_ok=True)
                result=f.update(check=False)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(before,f.production_fingerprint())
                self.assertFalse(any(x['kind'] in ('database','database-state','pm2','maintenance') for x in f.calls()))

    def test_production_version_mismatch_is_rejected_before_worker(self):
        f=self.fixture;f.install();f.set_production(SHA1,3203)
        model=json.loads(f.network.read_text());model['3203']['version']['gitSha']=SHA2
        write(f.network,json.dumps(model));before=f.production_fingerprint()
        result=f.update(check=False)
        self.assertNotEqual(result.returncode,0);self.assertEqual(before,f.production_fingerprint())
        self.assertFalse(any(x['kind'] in ('database','database-state','pm2','maintenance') for x in f.calls()))

    def test_old_fixed_tools_require_explicit_install_before_new_acceptance_update(self):
        f=self.fixture;f.old_fixed_tools()
        f.set_production(SHA1,3203)
        before=f.production_fingerprint();old=(f.launch/'dx-acceptance').read_bytes()
        result=f.update(check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(before,f.production_fingerprint())
        f.set_production(SHA1,3201)
        before=f.production_fingerprint();result=f.update(check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('TOOL_CODE_UPGRADE_REQUIRED',result.stderr)
        self.assertEqual(old,(f.launch/'dx-acceptance').read_bytes())
        self.assertEqual(before,f.production_fingerprint())
        self.assertIn('ACCEPTANCE_DIAGNOSTICS_FINISHED',f.run(f.launch/'dx-acceptance','diagnose',f.sha).stdout)
        self.assertEqual(old,(f.launch/'dx-acceptance').read_bytes(), 'Old diagnose must never refresh executable policy')
        handoff=f.repo/'docs/operations/g1-acceptance-compat-update.sh'
        self.assertIn('CHECK_FINISHED',f.run(handoff,'check',f.sha).stdout)
        self.assertEqual(before,f.production_fingerprint())
        self.assertIn('INSTALLED_TOOL_VERIFIED',f.run(handoff,'install',f.sha).stdout)
        self.assertEqual(before,f.production_fingerprint())
        self.assertIn('ACCEPTANCE_DIAGNOSTICS_FINISHED',f.run(handoff,'diagnose',f.sha).stdout)
        self.assertEqual(before,f.production_fingerprint())
        f.set_production(SHA1,3203);before=f.production_fingerprint()
        self.assertIn('ACCEPTANCE_UPDATE_FINISHED',f.run(handoff,'update',f.sha).stdout)
        self.assertEqual(before,f.production_fingerprint())

    def test_advanced_main_is_release_todo_without_blocking_independent_acceptance(self):
        f=self.fixture;f.install();before=f.production_fingerprint()
        command([REAL_GIT,'-C',str(f.repo),'checkout','-q','main'])
        sql='-- TEST next main migration, never executed\n'
        checksum=hashlib.sha256(sql.encode()).hexdigest()
        write(f.repo/'apps/api/migrations/0002_main_advanced.sql',sql)
        write(f.repo/'apps/api/src/platform/migration-manifest.json',json.dumps({'migrations':f.manifest['migrations']+[{'version':'0002_main_advanced','checksum':checksum}]})+'\n')
        command([REAL_GIT,'-C',str(f.repo),'add','.']);command([REAL_GIT,'-C',str(f.repo),'commit','-qm','TEST main advanced'])
        command([REAL_GIT,'-C',str(f.repo),'checkout','-q','release/digital-production-v1'])
        f.trace.unlink(missing_ok=True);result=f.update(check=False)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('MISSING_MAIN_IDENTITY',result.stdout)
        self.assertIn('PENDING_RELEASE_INTEGRATION',result.stdout)
        self.assertIn('\"productionPromotionVerified\": false',result.stdout)
        self.assertEqual(before,f.production_fingerprint())
        self.assertTrue(any(x['kind']=='maintenance' for x in f.calls()))
        metadata=[x for x in f.calls() if x['kind']=='capacity-metadata']
        self.assertTrue(metadata, 'Capacity must inspect only fixed catalog metadata before download')
        for call in metadata:
            self.assertTrue(call['readonly'])
            sql=' '.join(call['args'])
            self.assertNotIn('schema_migrations',sql)
            self.assertFalse(any(word in sql.upper() for word in ('INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'GRANT ')))

    def test_real_main_then_acceptance_then_main_controller_chain(self):
        f=self.fixture;f.install();f.setup_main_controller()
        dependency_before=fingerprint(f.runtime/'current/node_modules')
        sha1=f.next_main('first main update')
        self.assertIn('ONLINE_RELEASE_SUCCESS',f.main_update().stdout)
        self.assertEqual({'sha':sha1,'port':3203},json.loads((f.state/'active.json').read_text()))
        self.assertEqual('completed',(f.state/'phase').read_text().strip())
        before=f.production_fingerprint()
        command([REAL_GIT,'-C',str(f.repo),'checkout','-q','release/digital-production-v1'])
        f.install();f.update()
        self.assertEqual(before,f.production_fingerprint(), 'Acceptance installation/update changed production')
        self.assertEqual(dependency_before,fingerprint(f.runtime/'releases'/SHA0/'node_modules'))
        sha2=f.next_main('second main update')
        self.assertIn('ONLINE_RELEASE_SUCCESS',f.main_update().stdout)
        self.assertEqual({'sha':sha2,'port':3201},json.loads((f.state/'active.json').read_text()))
        self.assertEqual(str(f.runtime/'generations'/sha2),os.readlink(f.runtime/'active'))
        calls=f.calls()
        self.assertEqual([sha1,sha2],[x['sha'] for x in calls if x['kind']=='main-prepare'])
        self.assertEqual([3203,3201],[x['port'] for x in calls if x['kind']=='main-slot' and x['action']=='start'])

    def test_second_launcher_install_failure_restores_both_old_entries(self):
        f=self.fixture;f.old_fixed_tools()
        before=f.production_fingerprint()
        entries={name:(f.launch/name).read_bytes() for name in ('dx-acceptance','dx-rework-update')}
        write(f.directory/'fail-second-entry','fail once\n')
        result=f.install(check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('ENTRY_INSTALL_FAILED_ROLLED_BACK',result.stderr)
        self.assertEqual(entries,{name:(f.launch/name).read_bytes() for name in entries})
        self.assertEqual(before,f.production_fingerprint())
        # The immutable revision may remain. A safe retry installs precisely it.
        self.assertIn('Installed.',f.install().stdout)
        self.assertEqual(before,f.production_fingerprint())
        self.assertNotEqual(entries['dx-acceptance'],(f.launch/'dx-acceptance').read_bytes())

    def test_install_capacity_and_expected_sha_fail_before_archive_or_entry_changes(self):
        f=self.fixture;f.old_fixed_tools();before=f.production_fingerprint()
        entries={name:(f.launch/name).read_bytes() for name in ('dx-acceptance','dx-rework-update')}
        for phase in ('wrong-sha','install'):
            with self.subTest(phase=phase):
                write(f.trace,'')
                if phase=='install':write(f.directory/'capacity-state.json',json.dumps({'failPhase':'install'}))
                result=f.run(f.repo/'scripts/dx-acceptance.sh','install',SHA2 if phase=='wrong-sha' else f.sha,check=False)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(entries,{name:(f.launch/name).read_bytes() for name in entries})
                self.assertEqual(before,f.production_fingerprint())
                self.assertFalse(any(x['kind']=='git' and 'archive' in x['args'] for x in f.calls()))

    def test_wrong_acceptance_config_is_rejected_before_fetch_without_changing_runtime(self):
        f=self.fixture;f.install();before=f.production_fingerprint()
        config=f.acceptance/'shared/.env';original=config.read_text()
        for old,new in (('APP_BASE_PATH=/acceptance/','APP_BASE_PATH=/'),
                        ('ROOT_DINGTALK_USER_ID=uat-root','ROOT_DINGTALK_USER_ID=non-uat'),
                        ('ACCEPTANCE_LAB_ENABLED=true','ACCEPTANCE_LAB_ENABLED=false')):
            with self.subTest(setting=old.split('=')[0]):
                write(config,original.replace(old,new),0o600);write(f.trace,'')
                result=f.update(check=False)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('Acceptance identity/configuration mismatch',result.stdout+result.stderr)
                self.assertFalse(any(x['kind']=='git' and 'fetch' in x['args'] for x in f.calls()))
                self.assertFalse(any(x['kind'] in ('pm2','backup','maintenance') for x in f.calls()))
                self.assertEqual(before,f.production_fingerprint())
        write(config,original,0o600)

    def test_data_only_refresh_remains_exactly_reinstallable_without_runtime_evidence(self):
        f=self.fixture;f.install();original=f.sha;before=f.production_fingerprint()
        command([REAL_GIT,'-C',str(f.repo),'checkout','-q','release/digital-production-v1'])
        write(f.repo/'apps/fixture-data-only','TEST candidate with identical executable tool policy\n')
        command([REAL_GIT,'-C',str(f.repo),'add','apps/fixture-data-only'])
        command([REAL_GIT,'-C',str(f.repo),'commit','-qm','TEST data-only tool refresh'])
        f.sha=command([REAL_GIT,'-C',str(f.repo),'rev-parse','HEAD']).stdout.strip()
        f.candidate=f.acceptance/'candidates'/f.sha;f.release(f.candidate,f.sha,True)
        model=json.loads(f.network.read_text());model['acceptanceCandidate']=str(f.candidate);write(f.network,json.dumps(model))
        result=f.update()
        self.assertIn('ACCEPTANCE_TOOL_REFRESH_OK sha='+f.sha,result.stdout)
        self.assertTrue((f.tools/original).is_dir())
        target=f.tools/f.sha
        self.assertFalse((target/'.acceptance-preflight').exists())
        self.assertFalse((target/'acceptance-identity.json').exists(),'Instance evidence is not part of an immutable source revision')
        self.assertIn('Installed.',f.install().stdout,'Explicit install of the identical clean SHA must remain idempotent')
        self.assertEqual(before,f.production_fingerprint())
        for name in ('dx-acceptance','dx-rework-update'):
            self.assertIn(str(target),(f.launch/name).read_text())

    def test_each_capacity_failure_precedes_its_heavy_action_and_preserves_old_data(self):
        f=self.fixture;f.install();before=f.production_fingerprint()
        write(f.acceptance/'backups/postgres/retained-backup','retained')
        write(f.acceptance/'logs/retained-evidence','retained')
        for phase in ('download','archive','build','backup','stop'):
            with self.subTest(phase=phase):
                write(f.trace,'');write(f.directory/'capacity-state.json',json.dumps({'failPhase':phase}))
                result=f.update(check=False);calls=f.calls()
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertIn('capacity_insufficient',result.stdout)
                self.assertEqual(before,f.production_fingerprint())
                self.assertEqual('retained',(f.acceptance/'backups/postgres/retained-backup').read_text())
                self.assertEqual('retained',(f.acceptance/'logs/retained-evidence').read_text())
                self.assertFalse(any(x['kind']=='pm2' and x['args'][0] in ('stop','startOrReload') for x in calls))
                self.assertFalse(any(x['kind']=='maintenance' and x['action']=='apply' for x in calls))
                if phase=='download':self.assertFalse(any(x['kind']=='git' and 'fetch' in x['args'] for x in calls))
                if phase=='archive':self.assertFalse(any(x['kind']=='git' and 'archive' in x['args'] for x in calls))
                if phase in ('download','archive','build'):self.assertNotIn('[1/5]',result.stdout)
                if phase!='stop':self.assertFalse(any(x['kind']=='backup' for x in calls))
                else:self.assertTrue(any(x['kind']=='backup' for x in calls))

    def test_success_records_stage_capacity_and_persists_immutable_restart_generation(self):
        f=self.fixture;f.install();write(f.trace,'');result=f.update();calls=f.calls()
        self.assertIn('ACCEPTANCE_UPDATE_FINISHED',result.stdout)
        self.assertEqual(['download','archive','build','backup','stop'],[x['phase'] for x in calls if x['kind']=='capacity'])
        saved=json.loads((f.directory/'acceptance-home/.pm2/dump.pm2').read_text())[0]['pm2_env']
        self.assertEqual(str(f.acceptance/'releases'/f.sha),saved['pm_cwd'])
        self.assertEqual(str(f.acceptance/'releases'/f.sha/'scripts/deploy/start-acceptance-api.sh'),saved['pm_exec_path'])
        evidence=list((f.acceptance/'logs').glob('update-*'))[-1]
        self.assertEqual('verified',(evidence/'phase').read_text().strip())
        self.assertEqual(f.sha,json.loads((evidence/'saved-runtime.json').read_text())['sha'])
        self.assertTrue((evidence/'preflight/tree-sha').is_file())
        for phase in ('download','archive','build','backup','stop'):
            self.assertEqual('capacity_sufficient',json.loads((evidence/'preflight'/('capacity-'+phase+'.json')).read_text())['status'])

    def test_start_failure_keeps_stopped_registration_and_same_sha_retry_skips_migration(self):
        f=self.fixture;f.install();before=f.production_fingerprint();write(f.trace,'')
        write(f.directory/'fail-pm2-start-once','fail')
        result=f.update(check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('ACCEPTANCE_UPDATE_FINISHED',result.stdout)
        model=json.loads(f.network.read_text())
        self.assertTrue(model['acceptancePm2Present'])
        self.assertEqual(f.sha,model['acceptancePm2Sha'])
        self.assertEqual('stopped',model['acceptancePm2Status'])
        self.assertEqual(before,f.production_fingerprint())
        write(f.trace,'');retry=f.update();calls=f.calls()
        self.assertIn('ACCEPTANCE_UPDATE_FINISHED',retry.stdout)
        self.assertFalse(any(x['kind']=='backup' for x in calls))
        self.assertFalse(any(x['kind']=='maintenance' and x['action']=='apply' for x in calls))
        self.assertTrue(all(x['home']==str(f.directory/'acceptance-home/.pm2') for x in calls if x['kind']=='pm2'))
        write(f.trace,'');healthy=f.update();calls=f.calls()
        self.assertIn('Already current and healthy',healthy.stdout)
        self.assertFalse(any(x['kind']=='pm2' and x['args'][0] in ('stop','delete','startOrReload','save') for x in calls))
        self.assertEqual(before,f.production_fingerprint())

    def interrupt_after_delete(self):
        f=self.fixture;f.install();before=f.production_fingerprint()
        write(f.directory/'kill-after-pm2-delete','kill fixture session')
        result=f.update(check=False)
        self.assertEqual(-9,result.returncode)
        self.assertFalse(json.loads(f.network.read_text())['acceptancePm2Present'])
        self.assertEqual(before,f.production_fingerprint())
        checkpoint=f.acceptance/'shared/update-checkpoints'/(f.sha+'.pm2.json')
        self.assertEqual('registering',json.loads(checkpoint.read_text())['phase'])
        return f,before,checkpoint

    def test_hard_kill_after_delete_resumes_through_original_update_entry(self):
        f,before,checkpoint=self.interrupt_after_delete();write(f.trace,'')
        result=f.update();calls=f.calls()
        self.assertIn('ACCEPTANCE_UPDATE_FINISHED',result.stdout)
        self.assertFalse(any(x['kind']=='backup' for x in calls))
        self.assertFalse(any(x['kind']=='maintenance' and x['action']=='apply' for x in calls))
        self.assertEqual('verified',json.loads(checkpoint.read_text())['phase'])
        self.assertEqual(before,f.production_fingerprint())

    def test_hard_kill_after_start_revalidates_before_online_save(self):
        f=self.fixture;f.install();before=f.production_fingerprint();write(f.directory/'kill-after-pm2-start','kill fixture session')
        self.assertEqual(-9,f.update(check=False).returncode)
        self.assertEqual('online',json.loads(f.network.read_text())['acceptancePm2Status'])
        checkpoint=f.acceptance/'shared/update-checkpoints'/(f.sha+'.pm2.json')
        self.assertEqual('registering',json.loads(checkpoint.read_text())['phase'])
        saved=json.loads((f.directory/'acceptance-home/.pm2/dump.pm2').read_text())[0]['pm2_env']
        self.assertEqual('stopped',saved['status'])
        write(f.trace,'');result=f.update();calls=f.calls()
        self.assertIn('ACCEPTANCE_UPDATE_FINISHED',result.stdout)
        self.assertFalse(any(x['kind']=='backup' or (x['kind']=='maintenance' and x['action']=='apply') for x in calls))
        self.assertFalse(any(x['kind']=='pm2' and x['args'][0] in ('stop','delete','startOrReload') for x in calls))
        self.assertEqual('verified',json.loads(checkpoint.read_text())['phase'])
        self.assertEqual('online',json.loads((f.directory/'acceptance-home/.pm2/dump.pm2').read_text())[0]['pm2_env']['status'])
        self.assertEqual(before,f.production_fingerprint())

    def test_missing_registration_without_witness_is_rejected(self):
        f,before,checkpoint=self.interrupt_after_delete();checkpoint.unlink();write(f.trace,'')
        result=f.update(check=False)
        self.assertNotEqual(0,result.returncode)
        self.assertFalse(json.loads(f.network.read_text())['acceptancePm2Present'])
        self.assertFalse(any(x['kind']=='pm2' and x['args'][0] in ('startOrReload','save','delete') for x in f.calls()))
        self.assertEqual(before,f.production_fingerprint())

    def test_missing_registration_with_wrong_sha_is_rejected(self):
        f,before,checkpoint=self.interrupt_after_delete();data=json.loads(checkpoint.read_text());data['sha']=SHA0;checkpoint.write_text(json.dumps(data));write(f.trace,'')
        result=f.update(check=False)
        self.assertNotEqual(0,result.returncode)
        self.assertFalse(json.loads(f.network.read_text())['acceptancePm2Present'])
        self.assertFalse(any(x['kind']=='pm2' and x['args'][0] in ('startOrReload','save','delete') for x in f.calls()))
        self.assertEqual(before,f.production_fingerprint())

    def test_missing_registration_with_wrong_dump_is_rejected(self):
        f,before,checkpoint=self.interrupt_after_delete()
        dump=f.directory/'acceptance-home/.pm2/dump.pm2';data=json.loads(dump.read_text());data[0]['pm2_env']['status']='online';dump.write_text(json.dumps(data));write(f.trace,'')
        result=f.update(check=False)
        self.assertNotEqual(0,result.returncode)
        self.assertFalse(json.loads(f.network.read_text())['acceptancePm2Present'])
        self.assertFalse(any(x['kind']=='pm2' and x['args'][0] in ('startOrReload','save','delete') for x in f.calls()))
        self.assertEqual(before,f.production_fingerprint())

    def assert_stopped_save_blocks_migration(self,flag):
        f=self.fixture;f.install();before=f.production_fingerprint();write(f.trace,'')
        write(f.directory/flag,'fail');result=f.update(check=False);calls=f.calls()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(x['kind']=='maintenance' and x['action']=='apply' for x in calls))
        self.assertFalse(any(x['kind']=='pm2' and x['args'][0] in ('delete','startOrReload') for x in calls))
        self.assertEqual(before,f.production_fingerprint())
        self.assertEqual('stopped',json.loads(f.network.read_text())['acceptancePm2Status'])

    def test_first_stopped_save_failure_blocks_migration(self):
        self.assert_stopped_save_blocks_migration('fail-pm2-stop-save')

    def test_backup_stopped_save_failure_blocks_migration(self):
        self.assert_stopped_save_blocks_migration('fail-pm2-stop-backup-save')

    def test_pm2_persistence_failure_halts_only_acceptance_and_does_not_report_success(self):
        f=self.fixture;f.install();before=f.production_fingerprint();write(f.trace,'')
        write(f.directory/'fail-pm2-save','fail')
        result=f.update(check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('ACCEPTANCE_UPDATE_FINISHED',result.stdout)
        self.assertEqual(before,f.production_fingerprint())
        self.assertEqual('stopped',json.loads(f.network.read_text())['acceptancePm2Status'])
        self.assertTrue(any(x['kind']=='pm2' and x['args']==['save'] for x in f.calls()))
        self.assertTrue(any((p/'phase').read_text().strip()=='failed-runtime-stopped' for p in (f.acceptance/'logs').glob('update-*')))

    def test_failed_evidence_copy_cannot_prevent_halt_after_pm2_save_failure(self):
        f=self.fixture;f.install();before=f.production_fingerprint()
        write(f.directory/'fail-pm2-save','fail');write(f.directory/'fail-evidence-copy-on-save','fail')
        write(f.bin/'cp',"""#!/usr/bin/env bash
            if [[ -f '%s/fail-evidence-copy' && "$*" == *'.acceptance-preflight'* ]]; then
              echo TEST_EVIDENCE_COPY_FAILED >&2; exit 88
            fi
            exec /usr/bin/cp "$@"
        """ % f.directory,0o755)
        result=f.update(check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('ACCEPTANCE_UPDATE_FINISHED',result.stdout)
        self.assertTrue((f.directory/'fail-evidence-copy').is_file())
        self.assertEqual('stopped',json.loads(f.network.read_text())['acceptancePm2Status'])
        self.assertNotIn('TEST_EVIDENCE_COPY_FAILED',result.stderr,'Halt must stop the candidate before any optional evidence copy')
        self.assertEqual(before,f.production_fingerprint())


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--repository",type=Path,default=REPOSITORY)
    parser.add_argument("--main-tools",type=Path,default=MAIN_TOOLS)
    args,remaining=parser.parse_known_args()
    REPOSITORY=args.repository.resolve();MAIN_TOOLS=args.main_tools.resolve()
    unittest.main(argv=[sys.argv[0]]+remaining,verbosity=2)
