#!/usr/bin/env python3
"""Read-only, staged Acceptance capacity budget. Python 3.6, no env bypass."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import sys

MIB = 1024 * 1024
GIB = 1024 * MIB
ROOT = '/opt/dx-rework-acceptance'
REPOSITORY = '/opt/dx-rework/source'
TOOLS = '/opt/dx-rework-acceptance-tools'
PHASES = ('install', 'download', 'diagnose-download', 'archive', 'diagnose-archive', 'build', 'backup', 'stop')


def tree_bytes(directory, excluded=()):
    root = Path(directory)
    if not root.exists():
        return 0
    root = root.resolve()
    total = 0
    def unreadable(error):
        raise error
    for parent, directories, names in os.walk(str(root), followlinks=False, onerror=unreadable):
        directories[:] = [name for name in directories if name not in excluded
                          and not os.path.islink(os.path.join(parent, name))]
        for name in names:
            path = os.path.join(parent, name)
            if os.path.islink(path):
                continue
            info = os.stat(path)
            total += max(info.st_size, getattr(info, 'st_blocks', 0) * 512, 4096)
    return total


def git_bytes(repository):
    directory = Path(repository) / '.git'
    if directory.is_file():
        line = directory.read_text().strip()
        if not line.startswith('gitdir: '):
            raise ValueError('Invalid local Git directory reference')
        directory = (directory.parent / line[8:]).resolve()
    common = directory / 'commondir'
    if common.is_file():
        directory = (directory / common.read_text().strip()).resolve()
    return tree_bytes(directory)


def exact_tree_bytes(file):
    total = 0
    for line in Path(file).read_text().splitlines():
        fields = line.split('\t', 1)[0].split()
        if len(fields) != 4 or fields[1] != 'blob' or not fields[3].isdigit():
            raise ValueError('Invalid exact Git tree size evidence')
        total += int(fields[3]) + 4096
    if total == 0:
        raise ValueError('Empty exact Git tree size evidence')
    return total


def integer(value, name):
    if type(value) is not int or value < 0:
        raise ValueError('Invalid capacity metric: ' + name)
    return value


def filesystem(path):
    actual = Path(path).resolve()
    while not actual.exists():
        parent = actual.parent
        if parent == actual:
            raise ValueError('No filesystem for capacity path')
        actual = parent
    info, space = actual.stat(), os.statvfs(str(actual))
    if space.f_frsize <= 0 or space.f_bavail < 0 or space.f_blocks <= 0 or space.f_bavail > space.f_blocks:
        raise ValueError('Unavailable filesystem capacity: ' + str(actual))
    return {'device': str(info.st_dev), 'probe': str(actual),
            'available': space.f_bavail * space.f_frsize, 'total': space.f_blocks * space.f_frsize}


def components(phase, source, tool, storage=None, tree_file=None, target_sha=None):
    if phase not in PHASES:
        raise ValueError('Unknown capacity phase')
    source_size = max(128 * MIB, 2 * (exact_tree_bytes(tree_file) if tree_file else
                      max(tree_bytes(source, ('.git', 'node_modules', 'dist', '.acceptance-preflight')),
                          tree_bytes(tool, ('.git', 'node_modules', 'dist')))))
    dependency_roots = (Path(REPOSITORY), Path(ROOT) / 'current')
    dependency_sizes = [tree_bytes(root / 'node_modules') for root in dependency_roots]
    target = Path(tool) / 'package-lock.json'
    matched_sizes = []
    if target.is_file():
        target_lock = target.read_bytes()
        for root, measured in zip(dependency_roots, dependency_sizes):
            baseline = root / 'package-lock.json'
            if measured > 0 and baseline.is_file() and baseline.read_bytes() == target_lock:
                matched_sizes.append(measured)
    # A matching installed Acceptance lock is sizing evidence even when the
    # production checkout is older. This does not authorize dependency reuse:
    # the worker still performs its own locked install/validation.
    measured = max(matched_sizes or dependency_sizes)
    dependency_size = max(512 * MIB if matched_sizes else 2 * GIB,
                          (3 * measured + 1) // 2)
    output_size = max(256 * MIB, 2 * (tree_bytes(Path(ROOT) / 'current/apps/api/dist') +
                                     tree_bytes(Path(ROOT) / 'frontend/current')))
    items = []
    build = Path(ROOT) / 'build' / ('update-' + target_sha) if target_sha else Path(ROOT) / 'build'
    candidate = Path(ROOT) / 'candidates' / target_sha if target_sha else Path(ROOT) / 'candidates'
    release = Path(ROOT) / 'releases' / target_sha if target_sha else Path(ROOT) / 'releases'
    frontend = Path(ROOT) / 'frontend/releases' / target_sha if target_sha else Path(ROOT) / 'frontend/releases'

    def add(name, path, size):
        items.append({'name': name, 'paths': [str(path)], 'bytesPerFilesystem': size})

    if phase == 'install':
        add('immutable tool staging and entry backup', TOOLS, 2 * source_size + 32 * MIB)
        return items
    if phase in ('download', 'diagnose-download'):
        add('independent full Git object store', '/tmp', max(2 * GIB, 2 * git_bytes(REPOSITORY)))
        add('authenticated source Git fetch metadata', Path(REPOSITORY) / '.git', max(GIB, 2 * git_bytes(REPOSITORY)))
    if phase in ('download', 'diagnose-download', 'archive', 'diagnose-archive'):
        add('exact source archive and metadata', '/tmp', source_size + 32 * MIB)
    if phase.startswith('diagnose-'):
        return items
    if phase in ('download', 'archive'):
        add('possible immutable data-only tool staging', TOOLS, 2 * source_size)
    if phase == 'build':
        add('build source/dependencies/output', build, source_size + dependency_size + output_size)
        add('candidate bundle staging', candidate, source_size + dependency_size + output_size)
        add('installed API release with old generation retained', release, source_size + dependency_size + output_size)
        add('installed frontend release with old generation retained', frontend, output_size)
        add('npm locked-package cache', Path(ROOT) / 'build/npm-cache', dependency_size)
        add('npm/build extraction temporary set', Path(ROOT) / 'build/tmp', dependency_size)
    if not storage or storage.get('database') != 'dx_rework_acceptance':
        raise ValueError('Pinned Acceptance storage metadata is required')
    size = integer(storage.get('databaseBytes'), 'databaseBytes')
    wal = integer(storage.get('maxWalBytes'), 'maxWalBytes')
    paths = storage.get('dataPaths')
    if not isinstance(paths, list) or not paths or any(not isinstance(path, str) or not os.path.isabs(path) for path in paths):
        raise ValueError('Invalid database storage paths')
    # The fetch subprocess removes its Git store before returning. A fresh
    # build check measures free space before allocating builds or touching DB.
    # Archive covers extraction/tool refresh until that next check; allocations
    # already present on disk are accounted for by the live available probe.
    if phase in ('download', 'archive'):
        for key in ('walPath', 'logPath'):
            if not isinstance(storage.get(key), str) or not os.path.isabs(storage[key]):
                raise ValueError('Invalid PostgreSQL storage path: ' + key)
        return items
    if phase != 'stop':
        add('new consistent backup temporary set', Path(ROOT) / 'backups/postgres', 2 * size + 256 * MIB)
    items.append({'name': 'database rewrite per data filesystem', 'paths': paths, 'bytesPerFilesystem': 2 * size + 256 * MIB})
    for key in ('walPath', 'logPath'):
        if not isinstance(storage.get(key), str) or not os.path.isabs(storage[key]):
            raise ValueError('Invalid PostgreSQL storage path: ' + key)
    add('WAL growth and retained segments', storage['walPath'], 2 * max(size, wal) + GIB)
    add('PostgreSQL logs', storage['logPath'], max(256 * MIB, size // 4))
    add('Acceptance update/runtime logs', Path(ROOT) / 'logs', 128 * MIB)
    return items


def plan(items, probe=filesystem):
    volumes = {}
    for item in items:
        amount = integer(item['bytesPerFilesystem'], item['name'])
        seen = set()
        for path in item['paths']:
            measured = probe(path)
            available = integer(measured['available'], 'filesystem available')
            total = integer(measured['total'], 'filesystem total')
            if not total or available > total:
                raise ValueError('Invalid filesystem capacity')
            key = measured['device']
            volume = volumes.setdefault(key, {'device': key, 'availableBytes': available,
                                              'totalBytes': total, 'paths': [], 'components': []})
            volume['availableBytes'] = min(volume['availableBytes'], available)
            volume['totalBytes'] = min(volume['totalBytes'], total)
            volume['paths'].append({'path': path, 'probe': measured['probe']})
            if key not in seen:
                volume['components'].append({'name': item['name'], 'bytes': amount})
                seen.add(key)
    for volume in volumes.values():
        margin = max(512 * MIB, min(2 * GIB, (volume['totalBytes'] + 19) // 20))
        volume['components'].append({'name': 'filesystem operating headroom', 'bytes': margin})
        volume['requiredAdditionalBytes'] = sum(item['bytes'] for item in volume['components'])
        volume['shortfallBytes'] = max(0, volume['requiredAdditionalBytes'] - volume['availableBytes'])
    return list(volumes.values())


def main(argv, probe=filesystem):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=PHASES)
    parser.add_argument('source')
    parser.add_argument('tool')
    parser.add_argument('target_sha')
    parser.add_argument('--storage')
    parser.add_argument('--tree')
    args = parser.parse_args(argv)
    if args.target_sha != '-' and not re.fullmatch('[0-9a-f]{40}', args.target_sha):
        raise ValueError('Invalid pinned candidate SHA')
    marker = Path(args.tool) / 'TOOL_SHA'
    tool_sha = marker.read_text().strip() if marker.is_file() else args.target_sha
    if not re.fullmatch('[0-9a-f]{40}', tool_sha):
        raise ValueError('Invalid immutable tool SHA')
    storage = json.loads(Path(args.storage).read_text()) if args.storage else None
    volumes = plan(components(args.phase, args.source, args.tool, storage, args.tree,
                              args.target_sha if args.target_sha != '-' else None), probe)
    ok = all(volume['shortfallBytes'] == 0 for volume in volumes)
    print(json.dumps({'status': 'capacity_sufficient' if ok else 'capacity_insufficient',
                      'phase': args.phase, 'toolSha': tool_sha, 'targetSha': args.target_sha,
                      'observedAt': datetime.datetime.utcnow().isoformat() + 'Z', 'filesystems': volumes,
                      'limits': 'Estimate with stage rechecks, not a reservation; no files/backups removed.'}, sort_keys=True))
    return 0 if ok else 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'capacity_unavailable', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
