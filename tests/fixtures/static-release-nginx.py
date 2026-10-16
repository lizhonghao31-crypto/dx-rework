"""Run ONLY in a disposable root container with nginx/python3/curl/openssl.
DX_STATIC_DISPOSABLE=1 python3 tests/fixtures/static-release-nginx.py
No production paths, application services, databases or external HTTP.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

assert os.geteuid() == 0 and os.environ.get('DX_STATIC_DISPOSABLE') == '1'
source = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('static_release', str(source / 'scripts/deploy/static-release.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root = Path(tempfile.mkdtemp(prefix='isolated-nginx-static-')); root.chmod(0o755)
nginx = None
try:
    for name, base in [('main', '/'), ('acceptance', '/acceptance/')]:
        web = root / name
        (web / 'assets').mkdir(parents=True)
        (web / 'index.html').write_text('<script src="' + base + 'assets/app.js"></script><link rel="stylesheet" href="' + base + 'assets/app.css">')
        (web / 'assets/app.js').write_text('console.log("' + name + '")')
        (web / 'assets/app.css').write_text('body{color:blue}')
        (web / 'release-manifest.json').write_text(json.dumps({'viteBasePath': base}))
        web.chmod(0o700); (web / 'assets').chmod(0o700)
        for p in web.rglob('*'):
            if p.is_file(): p.chmod(0o600)
    private = root / 'private'; private.mkdir(mode=0o700)
    (private / '.env').write_text('SYNTHETIC_ONLY=1'); (private / '.env').chmod(0o600)
    cert, key = root / 'cert.pem', root / 'key.pem'
    subprocess.check_call(['openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=static.test', '-addext', 'subjectAltName=DNS:static.test'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.environ['CURL_CA_BUNDLE'] = str(cert)
    conf = root / 'nginx.conf'
    conf.write_text('''user www-data;
worker_processes 1;
pid %s/nginx.pid;
error_log %s/error.log;
events { worker_connections 64; }
http {
 access_log off;
 server {
  listen 443 ssl;
  server_name static.test;
  ssl_certificate %s;
  ssl_certificate_key %s;
  root %s/main;
  index index.html;
  location / { try_files $uri /index.html; }
  location /acceptance/ { alias %s/acceptance/; }
 }
}
''' % (root, root, cert, key, root, root))
    nginx = subprocess.Popen(['nginx', '-c', str(conf), '-g', 'daemon off;'])
    for _ in range(100):
        try:
            if m.identities(): break
        except (ValueError, FileNotFoundError): time.sleep(0.05)
    else: raise AssertionError('nginx worker did not start')
    def refused(operation):
        try: operation()
        except (ValueError, subprocess.SubprocessError): return
        raise AssertionError('unsafe case unexpectedly passed')
    # Actual worker identity cannot read 700/600, even when API would be healthy.
    refused(lambda: m.readable(root / 'main'))
    m.normalize(root / 'main'); m.readable(root / 'main'); m.http(root / 'main', 'static.test')
    assert (root / 'acceptance').stat().st_mode & 0o777 == 0o700
    assert private.stat().st_mode & 0o777 == 0o700
    assert (private / '.env').stat().st_mode & 0o777 == 0o600
    # Main repair cannot make Acceptance pass; it needs its own public tree.
    refused(lambda: m.readable(root / 'acceptance'))
    m.normalize(root / 'acceptance'); m.readable(root / 'acceptance'); m.http(root / 'acceptance', 'static.test')
    web = root / 'main'; asset = web / 'assets/app.js'
    asset.chmod(0o600)
    refused(lambda: m.readable(web)); refused(lambda: m.http(web, 'static.test'))
    asset.chmod(0o644)
    # A missing asset receives the SPA HTML with status 200: bytes must reject it.
    other = root / 'expected'; shutil.copytree(str(web), str(other))
    original = asset.read_bytes(); asset.unlink()
    refused(lambda: m.http(other, 'static.test'))
    asset.write_bytes(original); asset.chmod(0o644)
    # Wrong nginx root still responds 200; compare with expected release bytes.
    (other / 'assets/app.js').write_text('console.log("different release")')
    refused(lambda: m.http(other, 'static.test'))
    web.chmod(0o700); refused(lambda: m.readable(web)); refused(lambda: m.http(web, 'static.test'))
    m.normalize(web); m.readable(web); m.http(web, 'static.test')
    print('REAL_NGINX_STATIC_REGRESSION_OK main/acceptance permissions, private isolation, read/HTTP failure, recovery')
finally:
    if nginx:
        nginx.terminate(); nginx.wait(timeout=10)
    shutil.rmtree(str(root))
