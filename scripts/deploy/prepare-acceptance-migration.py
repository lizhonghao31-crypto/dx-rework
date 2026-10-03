#!/usr/bin/env python3
"""PR615 transaction runner with checksum-bound, read-only permission preflight."""
import hashlib
import json
import re
import shlex
import sys
from pathlib import Path


def permission_sql(entries, requirements):
    statements = ["DO $$ BEGIN IF NOT has_schema_privilege(current_user,'public','CREATE') THEN RAISE EXCEPTION 'Acceptance owner cannot create in public'; END IF; END $$;"]
    for row in entries:
        version = row['version']
        # Already-applied historical migrations do not need a deployment inventory.
        checks = requirements.get(version)
        statements += [f"SELECT NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{version}') AS pending \\gset", "\\if :pending"]
        if checks is None or checks['checksum'] != row['checksum']:
            statements += ["DO $$ BEGIN RAISE EXCEPTION 'Pending migration has no reviewed permission inventory'; END $$;", "\\endif"]
            continue
        if checks['creates']:
            for kind, privilege in [('r', 'SELECT'), ('r', 'INSERT'), ('r', 'UPDATE'), ('r', 'DELETE'), ('S', 'USAGE')]:
                statements.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND d.defaclnamespace IN (0,(SELECT oid FROM pg_namespace WHERE nspname='public')) AND d.defaclobjtype='{kind}' AND a.privilege_type='{privilege}' AND (a.grantee=0 OR pg_has_role('dx_rework_acceptance_app',a.grantee,'USAGE'))) THEN RAISE EXCEPTION 'Missing application default {kind} {privilege}; no automatic grant'; END IF; END $$;")
        tables = checks['tables'] + ['schema_migrations']
        for name in sorted(set(tables)):
            statements.append(f"DO $$ BEGIN IF to_regclass('public.{name}') IS NOT NULL AND NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.{name}')),'USAGE') THEN RAISE EXCEPTION 'Migration owner required: {name}'; END IF; END $$;")
        for name in checks.get('execute', []):
            statements.append(f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='{name}' AND NOT has_function_privilege(current_user,p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'Migration EXECUTE required: {name}'; END IF; END $$;")
        for name in checks['functions']:
            statements.append(f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='{name}' AND NOT pg_has_role(current_user,p.proowner,'USAGE')) THEN RAISE EXCEPTION 'Migration function owner required: {name}'; END IF; END $$;")
        for key, privilege in [('references', 'REFERENCES'), ('insert', 'INSERT'), ('update', 'UPDATE')]:
            for name in checks[key]:
                statements.append(f"DO $$ BEGIN IF to_regclass('public.{name}') IS NOT NULL AND NOT has_table_privilege(current_user,to_regclass('public.{name}'),'{privilege}') THEN RAISE EXCEPTION 'Migration {privilege} required: {name}'; END IF; END $$;")
        statements.append('\\endif')
    return statements


def generate(source, identity, node, history_file, mode='apply', tool_root=None):
    source = Path(source).resolve()
    tool_root = Path(tool_root or Path(__file__).resolve().parents[2])
    if mode not in ('preflight', 'apply'):
        raise ValueError('Unknown maintenance mode')
    if identity.get('database') != 'dx_rework_acceptance':
        raise ValueError('Maintenance database must be dx_rework_acceptance')
    if identity.get('address') not in (None, '127.0.0.1', '::1'):
        raise ValueError('Acceptance database must be local')
    port, oid = identity.get('port'), identity.get('oid')
    if type(port) is not int or not 1 <= port <= 65535 or type(oid) is not int or not 0 < oid <= 4294967295:
        raise ValueError('Invalid live database identity')
    manifest = source / 'apps/api/src/platform/migration-manifest.json'
    entries = json.loads(manifest.read_text())['migrations']
    if not entries:
        raise ValueError('Empty migration manifest')
    requirements = json.loads((tool_root / 'scripts/deploy/acceptance-migration-requirements.json').read_text())
    seen = set()
    for row in entries:
        version, checksum = row['version'], row['checksum']
        if not re.fullmatch(r'[0-9]{4}_[a-z0-9_]+', version) or not re.fullmatch(r'[0-9a-f]{64}', checksum) or version in seen:
            raise ValueError('Invalid or duplicate migration identity')
        seen.add(version)
        file = source / 'apps/api/migrations' / (version + '.sql')
        if hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            raise ValueError('Git SQL/manifest checksum drift: ' + version)
    policy = tool_root / 'scripts/deploy/acceptance-update-policy.mjs'
    command = ' '.join(shlex.quote(str(part)) for part in (node, policy, history_file, manifest, 'acceptance'))
    export = ("\\copy (SELECT json_build_object('database',current_database(),'migrations',coalesce("
              "json_agg(json_build_object('version',version,'checksum',btrim(checksum)) ORDER BY version),"
              "'[]'::json)) FROM schema_migrations) TO " + shlex.quote(str(history_file)))
    sql = ["\\set ON_ERROR_STOP on", "SET SESSION AUTHORIZATION dx_rework_acceptance;",
           "SET search_path=public;", "SET lock_timeout='5s';", "SET statement_timeout='120s';",
           "DO $$ BEGIN IF current_database()<>'dx_rework_acceptance' OR current_user<>'dx_rework_acceptance' "
           f"OR current_setting('port')::integer<>{port} OR "
           f"(SELECT oid::bigint FROM pg_database WHERE datname=current_database())<>{oid} OR "
           "(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())<>current_user "
           "THEN RAISE EXCEPTION 'Acceptance maintenance identity mismatch'; END IF; END $$;",
           "SELECT pg_advisory_lock(hashtext('dx-rework-schema-migrations'));", "BEGIN READ ONLY;", export,
           "\\! " + command, "\\if :SHELL_ERROR", "SELECT 1/0;", "\\endif"]
    sql += permission_sql(entries, requirements) + ['COMMIT;']
    if mode == 'apply':
        for row in entries:
            version, checksum = row['version'], row['checksum']
            file = source / 'apps/api/migrations' / (version + '.sql')
            sql.extend([f"SELECT NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{version}') AS pending \\gset",
                        "\\if :pending", "BEGIN;", "\\ir " + shlex.quote(str(file)),
                        f"INSERT INTO schema_migrations(version,checksum) VALUES('{version}','{checksum}');",
                        "COMMIT;", "\\endif"])
        sql.extend([export, "\\! " + command + " current", "\\if :SHELL_ERROR", "SELECT 1/0;", "\\endif"])
    sql.append("SELECT pg_advisory_unlock(hashtext('dx-rework-schema-migrations'));")
    return '\n'.join(sql) + '\n'


if __name__ == '__main__':
    source, identity, node, history, output, mode, tool_root = sys.argv[1:]
    Path(output).write_text(generate(source, json.loads(Path(identity).read_text()), node, history, mode, tool_root))
