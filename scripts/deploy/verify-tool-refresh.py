#!/usr/bin/env python3
"""Validate a data-only refresh using the already installed trust policy (Python 3.6)."""
import hashlib
import json
import os
import sys


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.sha256(stream.read()).hexdigest()


def files(root, directory):
    result = {}
    for parent, directories, names in os.walk(os.path.join(root, directory)):
        for name in directories + names:
            path = os.path.join(parent, name)
            if os.path.islink(path):
                raise ValueError('Tool refresh contains a symlink')
        for name in names:
            path = os.path.join(parent, name)
            result[os.path.relpath(path, root)] = digest(path)
    return result


def load(root, path):
    with open(os.path.join(root, path)) as stream:
        return json.load(stream)


def validate(installed, candidate):
    # Never run new executable policy just because it arrived at branch HEAD.
    # Routine migration compatibility refreshes may update data, not this kernel.
    data = 'scripts/migration-main-extensions.json'
    for directory in ('scripts', 'infra'):
        old, new = files(installed, directory), files(candidate, directory)
        old.pop(data, None)
        new.pop(data, None)
        if old != new:
            raise ValueError('TOOL_CODE_UPGRADE_REQUIRED: executable policy changed; audited installation required')
    for path in ('package.json', 'package-lock.json'):
        if digest(os.path.join(installed, path)) != digest(os.path.join(candidate, path)):
            raise ValueError('TOOL_CODE_UPGRADE_REQUIRED: dependency contract changed')
    old = load(installed, data)
    new = load(candidate, data)
    if new[:len(old)] != old:
        raise ValueError('Frozen main migration compatibility history changed')
    manifest_path = 'apps/api/src/platform/migration-manifest.json'
    old_rows = load(installed, manifest_path)['migrations']
    rows = load(candidate, manifest_path)['migrations']
    by_version = {row['version']: row['checksum'] for row in rows}
    if len(by_version) != len(rows):
        raise ValueError('Duplicate migration identity')
    for row in old_rows + new:
        if by_version.get(row['version']) != row['checksum']:
            raise ValueError('Frozen migration fingerprint changed or missing')
    sql_files = files(candidate, 'apps/api/migrations')
    expected = {'apps/api/migrations/' + row['version'] + '.sql': row['checksum'] for row in rows}
    actual = {path: value for path, value in sql_files.items() if path.endswith('.sql')}
    if actual != expected:
        raise ValueError('Migration SQL and manifest disagree')
    return len(rows)


if __name__ == '__main__':
    try:
        print('TOOL_REFRESH_VERIFIED migrations={}'.format(validate(*sys.argv[1:])))
    except (ValueError, KeyError, OSError, TypeError) as error:
        sys.exit(str(error))
