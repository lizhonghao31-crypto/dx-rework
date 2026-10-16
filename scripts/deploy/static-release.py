#!/usr/bin/env python3
"""Public frontend-only permissions and nginx probes; Python 3.6+, no dependencies."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from html.parser import HTMLParser
from urllib.parse import unquote, urljoin, urlsplit


def require(condition, message):
    if not condition:
        raise ValueError(message)


def tree(root):
    root = Path(os.path.abspath(str(root)))
    for parent in [root] + list(root.parents):
        require(stat.S_ISDIR(parent.lstat().st_mode), 'non-directory/symlink ancestor: ' + str(parent))
    entries = []
    # Only public Vite output and release integrity metadata, never arbitrary configs.
    extensions = {'.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
                  '.avif', '.ico', '.woff', '.woff2', '.ttf', '.eot'}
    def walk(directory):
        for path in [directory] + sorted(directory.iterdir()):
            info = path.lstat()
            rel = path.relative_to(root)
            require(not any(part.startswith('.') for part in rel.parts), 'hidden static path: ' + str(rel))
            require(not info.st_mode & 0o7000, 'special permission bits: ' + str(rel))
            require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'link/special static entry: ' + str(rel))
            if stat.S_ISDIR(info.st_mode):
                require(not rel.parts or rel.parts[0] == 'assets', 'unexpected static directory: ' + str(rel))
            else:
                require(info.st_nlink == 1, 'hard-linked static file: ' + str(rel))
                require(str(rel) in ('index.html', 'favicon.ico', 'release-manifest.json', 'SHA256SUMS') or
                        (len(rel.parts) > 1 and rel.parts[0] == 'assets' and path.suffix.lower() in extensions),
                        'non-public static file: ' + str(rel))
            entries.append((path, info))
            if path != directory and stat.S_ISDIR(info.st_mode):
                walk(path)
    walk(root)
    require((root / 'index.html').is_file(), 'missing index.html')
    return list({str(path): (path, info) for path, info in entries}.values())


def normalize(root):
    # Validate the ENTIRE tree before the first chmod. No owner or ancestor changes.
    entries = tree(root)
    for path, before in entries:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            now = os.fstat(fd)
            require((now.st_dev, now.st_ino, now.st_uid, now.st_gid, now.st_nlink) ==
                    (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_nlink), 'static entry changed')
            os.fchmod(fd, 0o755 if stat.S_ISDIR(now.st_mode) else 0o644)
        finally:
            os.close(fd)


class References(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self)
        self.values = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.values.append(attrs['src'])
        if tag == 'link' and attrs.get('href') and set(attrs.get('rel', '').split()) & {'stylesheet', 'modulepreload', 'preload', 'icon'}:
            self.values.append(attrs['href'])


def resources(root):
    entries = tree(root)
    manifest = json.loads((root / 'release-manifest.json').read_text())
    base = manifest.get('viteBasePath', '/')
    require(base in ('/', '/acceptance/'), 'unsupported frontend base path')
    parser = References()
    parser.feed((root / 'index.html').read_text())
    result = [(base, root / 'index.html')]
    for value in parser.values:
        # External runtime dependencies are not silently omitted from the release gate.
        url = urlsplit(urljoin('https://static.invalid' + base, value))
        require(url.scheme == 'https' and url.netloc == 'static.invalid' and not url.query and not url.fragment,
                'non-local or ambiguous static reference')
        decoded = unquote(url.path)
        require(decoded.startswith(base), 'reference outside app base')
        rel = decoded[len(base):]
        require(rel and all(x not in ('', '.', '..') for x in rel.split('/')), 'invalid static reference')
        path = root / rel
        require(any(path == entry[0] and stat.S_ISREG(entry[1].st_mode) for entry in entries), 'missing static reference: ' + rel)
        result.append((url.path, path))
    require(any(path.suffix == '.js' for _, path in result), 'no referenced application JavaScript')
    return result


def identities():
    found = set()
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if not (proc / 'cmdline').read_bytes().startswith(b'nginx: worker process'):
                continue
            fields = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
            master = Path('/proc') / fields['PPid'].strip()
            require((master / 'cmdline').read_bytes().startswith(b'nginx: master process') and
                    Path(os.readlink(str(master / 'exe'))).name == 'nginx', 'unexpected nginx master')
            uid = list(map(int, fields['Uid'].split()))
            gid = list(map(int, fields['Gid'].split()))
            require(uid[1] == uid[3] and gid[1] == gid[3] and uid[1] != 0, 'unsafe nginx worker identity')
            found.add((uid[1], gid[1], tuple(sorted(map(int, fields['Groups'].split())))))
        except (FileNotFoundError, ProcessLookupError):
            continue
    require(found, 'no live nginx worker identity; static preflight refused')
    return found


def readable(root):
    files = [str(path) for _, path in resources(root)]
    for uid, gid, groups in identities():
        def demote():
            if os.geteuid() == 0:
                os.setgroups(list(groups))
                os.setgid(gid)
                os.setuid(uid)
            else:
                require((os.geteuid(), os.getegid(), tuple(sorted(os.getgroups()))) == (uid, gid, groups),
                        'cannot assume nginx worker identity; use the authorized root controller')
        # Pass data only, never execute code from the candidate as root or nginx.
        subprocess.check_call([sys.executable, '-c',
                               'import sys; [open(p,"rb").read() for p in sys.argv[1:]]'] + files,
                              preexec_fn=demote, timeout=20)


def http(root, host):
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', host) is not None, 'invalid site host')
    for urlpath, path in resources(root):
        output = subprocess.check_output(['curl', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '7',
                                          '-fsS', '--resolve', host + ':443:127.0.0.1', '-w', '\n%{http_code}',
                                          'https://' + host + urlpath], timeout=9)
        body, code = output.rsplit(b'\n', 1)
        require(code == b'200', 'static HTTP not 200: ' + urlpath)
        require(hashlib.sha256(body).digest() == hashlib.sha256(path.read_bytes()).digest(),
                'static HTTP content differs: ' + urlpath)
    print('STATIC_HTTP_VERIFIED ' + str(root))


def main():
    require(len(sys.argv) in (3, 4), 'usage: static-release.py normalize|validate|readable|http ROOT [HOST]')
    action, root = sys.argv[1], Path(os.path.abspath(sys.argv[2]))
    if action == 'normalize':
        normalize(root)
    elif action == 'validate':
        tree(root)
    elif action == 'readable':
        readable(root)
    elif action == 'http' and len(sys.argv) == 4:
        http(root, sys.argv[3])
    else:
        raise ValueError('invalid static action')


if __name__ == '__main__':
    main()
