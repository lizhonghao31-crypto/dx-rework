#!/usr/bin/env python3
"""Read-only additional-space checks for persistent builds and immutable installs."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('capacity', str(Path(__file__).with_name('acceptance-capacity.py')))
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)


def allocations(mode, source, root, sha, cache=None, temporary=None):
    source, root = Path(source), Path(root)
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Invalid release SHA')
    items = []
    def add(name, path, size):
        items.append({'name': name, 'paths': [str(path)], 'bytesPerFilesystem': size})
    if mode == 'install':
        # Parent validates manifests/hashes before invoking this checker. An
        # existing destination is free only if the full tree is identical.
        for part, destination in [('api', root / 'releases' / sha), ('frontend', root / 'frontend/releases' / sha)]:
            if not (source / part).is_dir():
                raise ValueError('Missing installed release input')
            add('immutable ' + part + ' copy', destination,
                capacity.installed_allocation(source / part, destination))
    elif mode == 'build':
        lock = (source / 'package-lock.json').read_bytes()
        marker = root / 'shared/build-package-lock.sha256'
        dependencies = source / 'node_modules'
        ready = (dependencies.is_dir() and not dependencies.is_symlink() and
                 os.access(str(dependencies / '.bin/tsc'), os.X_OK) and os.access(str(dependencies / '.bin/vite'), os.X_OK) and
                 marker.is_file() and marker.read_text().strip() == hashlib.sha256(lock).hexdigest())
        measured = []
        for base in (source, root / 'current'):
            if base.resolve() == source.resolve() and not ready:
                continue
            if (base / 'package-lock.json').is_file() and (base / 'package-lock.json').read_bytes() == lock:
                size = capacity.tree_bytes(base / 'node_modules')
                if size:
                    measured.append(size)
        estimate = max(512 * capacity.MIB if measured else 2 * capacity.GIB,
                       (3 * max(measured or [0]) + 1) // 2)
        if not ready:
            # npm install can keep old dependencies while replacing packages.
            # Do not assume they are deleted or credit them as future free space.
            add('persistent source dependency installation', dependencies, estimate)
            add('npm cache growth', cache, estimate)
            add('npm extraction temporary set', temporary, estimate)
        output = max(256 * capacity.MIB, 2 * sum(capacity.tree_bytes(source / name) for name in
                     ('apps/api/dist', 'apps/web/dist', 'packages/config/dist', 'packages/contracts/dist', 'packages/domain/dist', 'packages/ui/dist')))
        add('persistent source build output', source, output)
        add('frontend publication', root / 'frontend/source-releases' / sha,
            max(128 * capacity.MIB, 2 * capacity.tree_bytes(source / 'apps/web/dist')))
    else:
        raise ValueError('Unknown release capacity phase')
    return items


def main(argv):
    if len(argv) not in (4, 6):
        raise ValueError('usage: MODE SOURCE ROOT SHA [NPM_CACHE TEMP]')
    mode, source, root, sha = argv[:4]
    if mode == 'build' and (len(argv) != 6 or any(not Path(path).is_absolute() for path in argv[4:])):
        raise ValueError('Explicit npm cache and temporary filesystem required')
    volumes = capacity.plan(allocations(mode, source, root, sha, *argv[4:]))
    ok = all(volume['shortfallBytes'] == 0 for volume in volumes)
    print(json.dumps({'status': 'capacity_sufficient' if ok else 'capacity_insufficient',
                      'phase': mode, 'targetSha': sha, 'filesystems': volumes}, sort_keys=True))
    return 0 if ok else 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'capacity_unavailable', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
