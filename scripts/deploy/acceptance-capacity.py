#!/usr/bin/env python3
"""Read-only, staged Acceptance capacity budget. Python 3.6, no env bypass."""
import argparse
import datetime
import hashlib
import subprocess
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


def verified_candidate(directory, sha, source):
    """Sizing evidence only; worker still verifies runtime, identity and schema.

    Never credit an unverified directory or a manifest-only stub as reusable.
    Hash the complete packaged file set, including provenance and nested sums.
    """
    root = Path(directory)
    if not root.exists():
        return False
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Unsafe existing candidate')
    sums = root / 'SHA256SUMS'
    expected = {}
    for line in sums.read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64}) [ *](.+)', line)
        if not match:
            raise ValueError('Invalid candidate checksums')
        name = match.group(2)
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or name in expected:
            raise ValueError('Unsafe candidate checksum path')
        expected[name] = match.group(1)
    actual = set()
    for parent, dirs, names in os.walk(str(root), followlinks=False):
        if any((Path(parent) / name).is_symlink() for name in dirs + names):
            raise ValueError('Candidate contains a symlink')
        for name in names:
            file = Path(parent) / name
            relative = str(file.relative_to(root))
            if relative == 'SHA256SUMS':
                continue
            actual.add(relative)
            digest = hashlib.sha256()
            with file.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            if expected.get(relative) != digest.hexdigest():
                raise ValueError('Candidate checksum mismatch: ' + relative)
    if actual != set(expected) or not actual:
        raise ValueError('Incomplete candidate checksums')
    for part in ('', 'api', 'frontend'):
        manifest = json.loads((root / part / 'release-manifest.json').read_text())
        if manifest.get('gitSha') != sha or manifest.get('appBasePath') != '/acceptance/':
            raise ValueError('Candidate SHA/base path mismatch')
    provenance = json.loads((root / 'build-provenance.json').read_text())
    if provenance.get('sourceSha') != sha or provenance.get('frontendSourceSha') != sha or provenance.get('frontendBuilt') is not True:
        raise ValueError('Candidate provenance mismatch')
    for name in ('package-lock.json', 'apps/api/src/platform/migration-manifest.json'):
        if (root / 'api' / name).read_bytes() != (Path(source) / name).read_bytes():
            raise ValueError('Candidate differs from pinned source: ' + name)
    return True


def installed_allocation(source, destination):
    """install-release refuses a different existing immutable destination."""
    destination = Path(destination)
    if not destination.exists() and not destination.is_symlink():
        return tree_bytes(source)
    if destination.is_symlink() or not destination.is_dir():
        raise ValueError('Unsafe installed release')
    result = subprocess.run(['diff', '-qr', '--no-dereference', str(source), str(destination)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode:
        raise ValueError('Existing installed release differs from candidate')
    return 0


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


def schema_unchanged(source, storage):
    # Missing evidence is deliberately the conservative migration branch. Equal
    # version numbers alone are insufficient: every applied checksum must match.
    file = Path(source) / 'apps/api/src/platform/migration-manifest.json'
    history = storage.get('migrations')
    if not file.is_file() or not isinstance(history, list) or not history:
        return False
    target = json.loads(file.read_text()).get('migrations')
    if not isinstance(target, list) or not target:
        return False
    def normalize(rows):
        result = {}
        for row in rows:
            version, checksum = row.get('version'), row.get('checksum')
            if not isinstance(version, str) or not re.fullmatch(r'[0-9a-f]{64}', checksum or '') or version in result:
                raise ValueError('Invalid migration sizing evidence')
            result[version] = checksum
        return result
    return normalize(target) == normalize(history)


def components(phase, source, tool, storage=None, tree_file=None, target_sha=None):
    if phase not in PHASES:
        raise ValueError('Unknown capacity phase')
    source_size = max(128 * MIB, 2 * (exact_tree_bytes(tree_file) if tree_file else
                      max(tree_bytes(source, ('.git', 'node_modules', 'dist', '.acceptance-preflight')),
                          tree_bytes(tool, ('.git', 'node_modules', 'dist')))))
    dependency_roots = (Path(REPOSITORY), Path(ROOT) / 'current')
    dependency_sizes = [tree_bytes(root / 'node_modules') for root in dependency_roots]
    # Build from the pinned source, not the possibly older installed tool.
    target = Path(source if phase == 'build' else tool) / 'package-lock.json'
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
    api_output = max(128 * MIB, 2 * (tree_bytes(Path(ROOT) / 'current/apps/api/dist') +
                                         tree_bytes(Path(ROOT) / 'current/packages')))
    web_output = max(128 * MIB, 2 * tree_bytes(Path(ROOT) / 'frontend/current'))
    output_size = api_output + web_output
    items = []
    build = Path(ROOT) / 'build' / ('update-' + target_sha) if target_sha else Path(ROOT) / 'build'
    candidate = Path(ROOT) / 'candidates' / target_sha if target_sha else Path(ROOT) / 'candidates'
    release = Path(ROOT) / 'releases' / target_sha if target_sha else Path(ROOT) / 'releases'
    frontend = Path(ROOT) / 'frontend/releases' / target_sha if target_sha else Path(ROOT) / 'frontend/releases'

    def add(name, path, size, stages=None):
        item = {'name': name, 'paths': [str(path)], 'bytesPerFilesystem': size}
        if stages is not None:
            item['stages'] = stages
        items.append(item)

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
        marker = Path(tool) / 'TOOL_SHA'
        # The controller skips refresh altogether for this exact tool version.
        if not target_sha or not marker.is_file() or marker.read_text().strip() != target_sha:
            add('possible immutable data-only tool staging', TOOLS, 2 * source_size)
    candidate_reused = False
    if phase == 'build':
        candidate_reused = bool(target_sha and verified_candidate(candidate, target_sha, source))
        if candidate_reused:
            # Existing bytes already reduce statvfs.available. Only missing
            # installed copies allocate space; existing copies must be identical.
            add('installed API release with old generation retained', release,
                installed_allocation(candidate / 'api', release), ['install', 'database'])
            add('installed frontend release with old generation retained', frontend,
                installed_allocation(candidate / 'frontend', frontend), ['install', 'database'])
        else:
            add('build source/dependencies/output', build, source_size + dependency_size + output_size)
            add('candidate bundle staging', candidate, source_size + dependency_size + output_size)
            add('installed API release with old generation retained', release, source_size + dependency_size + api_output, ['install', 'database'])
            add('installed frontend release with old generation retained', frontend, web_output, ['install', 'database'])
            add('npm locked-package cache', Path(ROOT) / 'build/npm-cache', dependency_size)
            add('npm/build extraction temporary set', Path(ROOT) / 'build/tmp', dependency_size, ['build'])
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
    unchanged = schema_unchanged(source, storage)
    verification_only = (phase == 'build' and candidate_reused and unchanged and
                         (Path(ROOT) / 'current').resolve() == release.resolve() and
                         (Path(ROOT) / 'frontend/current').resolve() == frontend.resolve())
    if verification_only:
        # The worker's existing same-SHA/current-schema policy can only verify
        # or reactivate (or reject an invalid PM2 state), never run a backup or
        # migration. Keep filesystem headroom checks, not imaginary copies.
        items.append({'name': 'unchanged database operating headroom', 'paths': paths, 'bytesPerFilesystem': 0})
        for key in ('walPath', 'logPath'):
            if not isinstance(storage.get(key), str) or not os.path.isabs(storage[key]):
                raise ValueError('Invalid PostgreSQL storage path: ' + key)
            add('unchanged ' + key + ' operating headroom', storage[key], 0)
        add('Acceptance update/runtime logs', Path(ROOT) / 'logs', 128 * MIB)
        return items
    if phase != 'stop':
        add('new consistent backup temporary set', Path(ROOT) / 'backups/postgres', 2 * size + 256 * MIB, ['database'] if phase == 'build' else None)
    items.append({'name': 'database rewrite per data filesystem', 'paths': paths, 'bytesPerFilesystem': 0 if unchanged else 2 * size + 256 * MIB,
                  **({'stages': ['database']} if phase == 'build' else {})})
    for key in ('walPath', 'logPath'):
        if not isinstance(storage.get(key), str) or not os.path.isabs(storage[key]):
            raise ValueError('Invalid PostgreSQL storage path: ' + key)
    add('WAL growth and retained segments', storage['walPath'], 256 * MIB if unchanged else 2 * max(size, wal) + GIB, ['database'] if phase == 'build' else None)
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
                component = {'name': item['name'], 'bytes': amount}
                if 'stages' in item:
                    if not item['stages'] or any(stage not in ('build', 'install', 'database') for stage in item['stages']):
                        raise ValueError('Invalid capacity lifecycle stage')
                    component['stages'] = item['stages']
                volume['components'].append(component)
                seen.add(key)
    for volume in volumes.values():
        margin = max(512 * MIB, min(2 * GIB, (volume['totalBytes'] + 19) // 20))
        volume['components'].append({'name': 'filesystem operating headroom', 'bytes': margin})
        stages = sorted({stage for item in volume['components'] for stage in item.get('stages', [])})
        if stages:
            volume['stageAdditionalBytes'] = {stage: sum(item['bytes'] for item in volume['components']
                                                        if 'stages' not in item or stage in item['stages'])
                                              for stage in stages}
            volume['requiredAdditionalBytes'] = max(volume['stageAdditionalBytes'].values())
        else:
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
