#!/usr/bin/env python3
"""Collect verified, unreferenced build workspaces under the held update locks.

No release, candidate, backup, npm cache, business file or unverified failed
build is removed. An unreadable runtime reference makes collection a no-op.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('capacity', str(Path(__file__).with_name('acceptance-capacity.py')))
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)


def beneath(path, directory):
    try:
        Path(str(path)[:-10] if str(path).endswith(' (deleted)') else str(path)).resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def referenced(directory, root, proc):
    # Generations are rollback references too, not just the current symlinks.
    links = [root / 'current', root / 'frontend/current',
             Path('/opt/dx-rework/current'), Path('/opt/dx-rework/frontend/current')]
    for generations in (root / 'generations', Path('/opt/dx-rework/generations')):
        if generations.exists():
            for parent, dirs, files in os.walk(str(generations), followlinks=False):
                links.extend(Path(parent) / name for name in dirs + files)
    for link in links:
        if link.is_symlink() and beneath(link.resolve(), directory):
            return True
    for process in proc.iterdir():
        if not process.name.isdigit():
            continue
        try:
            refs = [process / 'cwd', process / 'exe']
            if (process / 'fd').exists():
                refs.extend((process / 'fd').iterdir())
            for ref in refs:
                try:
                    target = os.readlink(str(ref))
                except FileNotFoundError:
                    continue
                if target.startswith('/') and beneath(target, directory):
                    return True
            cmdline = process / 'cmdline'
            if cmdline.exists():
                for argument in cmdline.read_bytes().split(b'\0'):
                    if argument.startswith(b'/') and beneath(os.fsdecode(argument), directory):
                        return True
            maps = process / 'maps'
            if maps.exists():
                for line in maps.read_text().splitlines():
                    parts = line.split(None, 5)
                    if len(parts) == 6 and parts[5].startswith('/') and beneath(parts[5], directory):
                        return True
        except FileNotFoundError:
            continue  # Process exited while inspecting it.
        except (PermissionError, OSError):
            return True  # Cannot prove it is unreferenced.
    return False


def collect(root, proc, owner):
    root, proc = Path(root), Path(proc)
    build_root = root / 'build'
    if root.is_symlink() or build_root.is_symlink() or not build_root.is_dir():
        raise ValueError('Unsafe build root')
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ValueError('Descriptor-safe removal unavailable')
    results = []
    for directory in sorted(build_root.iterdir()):
        if not re.fullmatch(r'update-[0-9a-f]{40}', directory.name):
            continue
        result = {'path': str(directory), 'status': 'retained'}
        results.append(result)
        try:
            if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != owner:
                raise ValueError('Unsafe build ownership/type')
            device = directory.stat().st_dev
            for parent, dirs, files in os.walk(str(directory), followlinks=False):
                if os.stat(parent).st_dev != device:
                    raise ValueError('Build contains another mounted filesystem')
            sha = directory.name[7:]
            if not capacity.verified_candidate(root / 'candidates' / sha, sha, directory):
                raise ValueError('No verified candidate; keep retry workspace')
            if referenced(directory, root, proc):
                raise ValueError('Runtime/rollback reference exists or cannot be inspected')
            size = capacity.tree_bytes(directory)
            shutil.rmtree(str(directory))
            result.update(status='removed', bytes=size)
        except (ValueError, OSError, KeyError, TypeError) as error:
            result['reason'] = str(error)
    return results


def main():
    root = Path('/opt/dx-rework-acceptance')
    if os.getuid() != 0:
        raise ValueError('Root update controller required')
    for fd, path in [(8, '/run/lock/dx-acceptance-update.lock'), (9, str(root / 'locks/release.lock'))]:
        if Path(os.readlink('/proc/self/fd/' + str(fd))).resolve() != Path(path).resolve():
            raise ValueError('Expected inherited update lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print(json.dumps({'buildCollection': collect(root, Path('/proc'), pwd.getpwnam('dxacceptance').pw_uid)}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'build_collection_unavailable', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
