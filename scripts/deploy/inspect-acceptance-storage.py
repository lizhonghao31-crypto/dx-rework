#!/usr/bin/env python3
"""Fixed, read-only storage metadata through the existing local peer boundary."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

DEPLOY = '/opt/dx-rework-acceptance/shared/deploy.env'


def trusted_psql(config=DEPLOY, owner_uid=0):
    values = {}
    for line in Path(config).read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key] = value
    directory = values.get('DX_REWORK_PG_BIN_DIR', '')
    if not directory or not os.path.isabs(directory):
        raise ValueError('Approved PostgreSQL client directory is required')
    executable = (Path(directory) / 'psql').resolve(strict=True)
    for path in (executable,) + tuple(executable.parents):
        info = path.stat()
        if info.st_uid not in (0, owner_uid) or info.st_mode & 0o022:
            raise ValueError('PostgreSQL client is not root controlled')
    if not executable.is_file() or not os.access(str(executable), os.X_OK):
        raise ValueError('Approved PostgreSQL client is not executable')
    return str(executable)


def identity_values(identity):
    if identity.get('database') != 'dx_rework_acceptance' or identity.get('role') != 'dx_rework_acceptance_app' or identity.get('sessionRole') != 'dx_rework_acceptance_app':
        raise ValueError('Acceptance database/runtime role mismatch')
    if identity.get('address') not in (None, '127.0.0.1', '::1'):
        raise ValueError('Acceptance database must be on this host')
    port, oid = identity.get('port'), identity.get('oid')
    if type(port) is not int or not 1 <= port <= 65535 or type(oid) is not int or not 0 < oid <= 4294967295:
        raise ValueError('Invalid pinned database port/OID')
    return port, oid


def storage_query(identity):
    port, oid = identity_values(identity)
    # No caller SQL, identifiers, URLs, GUC proof or role changes. Search path is
    # pinned to pg_catalog by the command. Runtime receives no extra privilege.
    return """SELECT json_build_object(
      'database',current_database(),'port',current_setting('port')::integer,
      'oid',d.oid::bigint,'storageRole',current_user,
      'serverVersion',current_setting('server_version_num')::integer,
      'databaseBytes',pg_database_size(d.oid),
      'dataDirectory',current_setting('data_directory'),
      'maxWalBytes',pg_size_bytes(current_setting('max_wal_size')),
      'logDirectory',current_setting('log_directory'),
      'directoryPaths',(SELECT coalesce(json_agg(p),'[]'::json) FROM (
        SELECT DISTINCT regexp_replace(pg_relation_filepath(c.oid),'/[^/]+$','') AS p
        FROM pg_class c WHERE pg_relation_filepath(c.oid) IS NOT NULL) paths))
      FROM pg_database d WHERE d.datname=current_database()
      AND current_database()='dx_rework_acceptance' AND current_user='postgres'
      AND d.oid::bigint=%d AND current_setting('port')::integer=%d""" % (oid, port)


def collect(identity, psql, run=subprocess.run):
    port, oid = identity_values(identity)
    result = run(['runuser', '-u', 'postgres', '--', 'env', '-i', 'PATH=/usr/bin:/bin',
                  'PGCONNECT_TIMEOUT=10', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000',
                  psql, '-XqAt', '--port=' + str(port), '--dbname=dx_rework_acceptance',
                  '-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY',
                  '-c', 'SET LOCAL search_path=pg_catalog', '-c', storage_query(identity), '-c', 'COMMIT'],
                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=15)
    if result.returncode:
        raise ValueError('Fixed read-only Acceptance storage inspection failed; no privileges changed')
    value = json.loads(result.stdout)
    if value.get('database') != identity['database'] or value.get('port') != port or value.get('oid') != oid or value.get('storageRole') != 'postgres':
        raise ValueError('Pinned Acceptance storage identity changed')
    for key in ('databaseBytes', 'maxWalBytes', 'serverVersion'):
        if type(value.get(key)) is not int or value[key] < 0:
            raise ValueError('Invalid PostgreSQL storage metric: ' + key)
    base = value.get('dataDirectory')
    if not isinstance(base, str) or not os.path.isabs(base):
        raise ValueError('Invalid PostgreSQL data directory')
    paths = value.get('directoryPaths')
    if not isinstance(paths, list):
        raise ValueError('Missing actual database relation directories')
    data_paths = []
    for path in paths:
        if not isinstance(path, str) or os.path.isabs(path) or '..' in Path(path).parts:
            raise ValueError('Invalid PostgreSQL relation directory')
        data_paths.append(str(Path(base) / path))
    if not data_paths:
        raise ValueError('Missing actual database relation directories')
    log = value.get('logDirectory')
    if not isinstance(log, str) or not log:
        raise ValueError('Invalid PostgreSQL log directory')
    value.update(dataPaths=sorted(set(data_paths)), walPath=str(Path(base) / 'pg_wal'),
                 logPath=log if os.path.isabs(log) else str(Path(base) / log))
    return value


def main(argv, owner_uid=0, psql=None):
    if os.getuid() != owner_uid or len(argv) != 2:
        raise ValueError('Storage inspection requires the root controller and pinned identity/output files')
    identity_file, output = map(Path, argv)
    info = identity_file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
        raise ValueError('Acceptance identity evidence must be root controlled')
    identity = json.loads(identity_file.read_text())
    identity_values(identity)
    if str(output) == '--validate-only':
        return
    value = collect(identity, psql or trusted_psql(owner_uid=owner_uid))
    with tempfile.NamedTemporaryFile(mode='w', dir=str(output.parent), delete=False) as stream:
        temporary = stream.name
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
    os.chmod(temporary, 0o444)
    os.replace(temporary, str(output))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        sys.exit('ACCEPTANCE_STORAGE_INSPECTION_FAILED: ' + str(error))
