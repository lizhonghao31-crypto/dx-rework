#!/usr/bin/env python3
"""Generate a locked, owner-role psql migration session from an immutable Git snapshot."""
import hashlib
import json
import re
import shlex
import sys
from pathlib import Path


def generate(source, identity, node, history_file):
    source = Path(source).resolve()
    if identity.get('database') != 'dx_rework_acceptance':
        raise ValueError('Maintenance database must be dx_rework_acceptance')
    if identity.get('address') not in (None, '127.0.0.1', '::1'):
        raise ValueError('Acceptance database must be local')
    port, oid = identity.get('port'), identity.get('oid')
    if type(port) is not int or not 1 <= port <= 65535 or type(oid) is not int or oid <= 0:
        raise ValueError('Invalid live database identity')
    manifest = source / 'apps/api/src/platform/migration-manifest.json'
    entries = json.loads(manifest.read_text())['migrations']
    if not entries:
        raise ValueError('Empty migration manifest')
    policy = source / 'scripts/deploy/acceptance-update-policy.mjs'
    command = ' '.join(shlex.quote(str(part)) for part in (node, policy, history_file, manifest, 'acceptance'))
    export = ("\\copy (SELECT json_build_object('database',current_database(),'migrations',coalesce("
              "json_agg(json_build_object('version',version,'checksum',btrim(checksum)) ORDER BY version),"
              "'[]'::json)) FROM schema_migrations) TO " + shlex.quote(str(history_file)))
    sql = ["\\set ON_ERROR_STOP on", "SET SESSION AUTHORIZATION dx_rework_acceptance;",
           "DO $$ BEGIN IF current_database()<>'dx_rework_acceptance' OR current_user<>'dx_rework_acceptance' "
           f"OR current_setting('port')::integer<>{port} OR "
           f"(SELECT oid FROM pg_database WHERE datname=current_database())<>{oid} OR "
           "(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())<>current_user "
           "THEN RAISE EXCEPTION 'Acceptance maintenance identity mismatch'; END IF; END $$;",
           "SELECT pg_advisory_lock(hashtext('dx-rework-schema-migrations'));", export,
           "\\! " + command, "\\if :SHELL_ERROR", "SELECT 1/0;", "\\endif"]
    seen = set()
    for row in entries:
        version, checksum = row['version'], row['checksum']
        if not re.fullmatch(r'[0-9]{4}_[a-z0-9_]+', version) or not re.fullmatch(r'[0-9a-f]{64}', checksum) or version in seen:
            raise ValueError('Invalid or duplicate migration identity')
        seen.add(version)
        file = source / 'apps/api/migrations' / (version + '.sql')
        if hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            raise ValueError('Git SQL/manifest checksum drift: ' + version)
        sql.extend([f"SELECT NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{version}') AS pending \\gset",
                    "\\if :pending", "BEGIN;", "\\ir " + shlex.quote(str(file)),
                    f"INSERT INTO schema_migrations(version,checksum) VALUES('{version}','{checksum}');",
                    "COMMIT;", "\\endif"])
    sql.extend([export, "\\! " + command + " current", "\\if :SHELL_ERROR", "SELECT 1/0;", "\\endif",
                "SELECT pg_advisory_unlock(hashtext('dx-rework-schema-migrations'));"])
    return '\n'.join(sql) + '\n'


if __name__ == '__main__':
    source, identity, node, history, output = sys.argv[1:]
    Path(output).write_text(generate(source, json.loads(Path(identity).read_text()), node, history))
