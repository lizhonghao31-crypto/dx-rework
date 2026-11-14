#!/usr/bin/env python3
"""Remove only Git-listed source files from this invocation's failed snapshot.

Preflight reports, migration SQL/history, runtime identity and the pointer to
worker logs remain at the reported evidence path. No directory sweep/old-run
collection and no traversal through symlinks or mounted subdirectories.
"""
import json
import os
from pathlib import Path
import sys


def trim(snapshot):
    root = Path(snapshot)
    listing = root / '.acceptance-preflight/tree-sizes.txt'
    if root.is_symlink() or not root.is_dir() or not listing.is_file():
        return {'status': 'retained', 'reason': 'No exact source inventory'}
    paths = []
    device = root.stat().st_dev
    for line in listing.read_text().splitlines():
        metadata, name = line.split('\t', 1)
        fields = metadata.split()
        if len(fields) != 4 or fields[1] != 'blob' or not fields[3].isdigit() or name.startswith('"'):
            return {'status': 'retained', 'reason': 'Unsupported source inventory'}
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or path.parts[0] == '.acceptance-preflight':
            raise ValueError('Unsafe source inventory')
        file = root / path
        for parent in file.parents:
            if parent == root:
                break
            if parent.is_symlink() or (parent.exists() and parent.stat().st_dev != device):
                raise ValueError('Unsafe source parent')
        if file.exists() and file.is_dir():
            raise ValueError('Source file replaced by directory')
        paths.append(file)
    for file in paths:
        if file.exists() or file.is_symlink():
            file.unlink()
    parents = {parent for file in paths for parent in file.parents if root in parent.parents}
    for path in sorted(parents, key=lambda value: len(value.parts), reverse=True):
        try:
            path.rmdir()  # Empty only; unknown diagnostic files stay untouched.
        except OSError:
            pass
    return {'status': 'source_removed_evidence_retained', 'sourceFiles': len(paths)}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or os.getuid() != 0 or not str(sys.argv[1]).startswith('/tmp/dx-acceptance-source.'):
            raise ValueError('Expected this controller root-owned source snapshot')
        snapshot = Path(sys.argv[1])
        if snapshot.parent != Path('/tmp') or snapshot.stat().st_uid != 0:
            raise ValueError('Unsafe snapshot ownership/path')
        print(json.dumps(trim(snapshot)))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'source_retained', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
