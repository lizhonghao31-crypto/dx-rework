#!/usr/bin/env python3
"""Read-only permission diagnostics and checksum-bound transactional object grants."""
import hashlib
import json
import re
import shlex
import sys
from pathlib import Path


def permission_query(entries, requirements):
    """One read-only result set: report every pending requirement before rejecting."""
    rows = []
    app = "'dx_rework_acceptance_app'"
    def add(version, kind, name, required, ok, owner="NULL::text", acl="NULL::text", access="'{}'::jsonb", tail=""):
        pending = "true" if version is None else "NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{}')".format(version)
        rows.append("SELECT jsonb_build_object('migration',{},'kind','{}','object','{}','required','{}','owner',{},'acl',{},'application',{}) AS report, coalesce(({}),false) AS ok {} WHERE {}".format(
            "NULL" if version is None else "'{}'".format(version), kind, name, required, owner, acl, access, ok, tail, pending))
    add(None, 'schema', 'public', 'CREATE', "has_schema_privilege(current_user,'public','CREATE')")
    future_tables = {}
    for row in entries:
        check = requirements.get(row['version'], {})
        if check.get('checksum') == row['checksum']:
            for name in check['creates']:
                future_tables[name] = row['version']
    for row in entries:
        version = row['version']
        checks = requirements.get(version)
        if checks is None or checks['checksum'] != row['checksum']:
            add(version, 'inventory', version, 'CHECKSUM_BOUND_INVENTORY', 'false')
            continue
        def table(name, required):
            future = "NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{}')".format(future_tables[name]) if name in future_tables else 'false'
            allowed = "pg_has_role(current_user,c.relowner,'USAGE')" if required == 'OWNER' else "has_table_privilege(current_user,c.oid,'{}')".format(required)
            access = "jsonb_build_object(" + ','.join("'{0}',CASE WHEN c.oid IS NULL THEN NULL ELSE has_table_privilege({1},c.oid,'{0}') END".format(priv, app) for priv in ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) + ")"
            add(version, 'table', name, required, "CASE WHEN c.oid IS NULL THEN {} ELSE {} END".format(future, allowed),
                'pg_get_userbyid(c.relowner)', 'c.relacl::text', access,
                "FROM (SELECT to_regclass('public.{}') AS oid) x LEFT JOIN pg_class c ON c.oid=x.oid".format(name))
        for name in sorted(set(checks['tables'] + ['schema_migrations'])):
            table(name, 'OWNER')
        for key, privilege in [('references', 'REFERENCES'), ('insert', 'INSERT'), ('update', 'UPDATE')]:
            for name in checks[key]:
                table(name, privilege)
        for key, required in [('functions', 'OWNER'), ('execute', 'EXECUTE')]:
            for name in checks[key]:
                allowed = "pg_has_role(current_user,p.proowner,'USAGE')" if required == 'OWNER' else "has_function_privilege(current_user,p.oid,'EXECUTE')"
                add(version, 'function', name, required, 'coalesce(f.allowed,true)', 'f.owners', 'f.acls', "coalesce(f.application,'{}'::jsonb)",
                    "FROM (SELECT bool_and({}) allowed, string_agg(pg_get_userbyid(p.proowner),',') owners, string_agg(p.proacl::text,',') acls, jsonb_object_agg(p.oid::regprocedure::text,has_function_privilege({},p.oid,'EXECUTE')) application FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='{}') f".format(allowed, app, name))
        for name in checks['creates']:
            add(version, 'new_table', name, 'ABSENT_BEFORE_MIGRATION', "to_regclass('public.{}') IS NULL".format(name))
        for seq in checks['sequences']:
            add(version, 'new_sequence', seq['name'], 'ABSENT_BEFORE_MIGRATION', "to_regclass('public.{}') IS NULL".format(seq['name']))
    return '\nUNION ALL\n'.join(rows)


def permission_sql(entries, requirements):
    query = permission_query(entries, requirements)
    return [
        # PG16 added per-membership options. Read row JSON so earlier servers do
        # not resolve absent columns; not_applicable is distinct from false.
        # Effective authorization still comes from pg_has_role, never these labels.
        "SELECT json_build_object('server_version_num',current_setting('server_version_num')::integer,'maintenance_role',current_user,'application_role','dx_rework_acceptance_app','application_inherits_maintenance',pg_has_role('dx_rework_acceptance_app',current_user,'USAGE'),'maintenance_inherits_application',pg_has_role(current_user,'dx_rework_acceptance_app','USAGE'),'memberships',(SELECT coalesce(json_agg(json_build_object('member',r.rolname,'role',pg_get_userbyid(m.roleid),'member_rolinherit',r.rolinherit,'inherit',coalesce(to_jsonb(m)->'inherit_option','\"not_applicable\"'::jsonb),'set',coalesce(to_jsonb(m)->'set_option','\"not_applicable\"'::jsonb))),'[]'::json) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE m.member IN ('dx_rework_acceptance'::regrole,'dx_rework_acceptance_app'::regrole)));",
        "WITH diagnostics AS (" + query + ") SELECT coalesce(jsonb_agg(report || jsonb_build_object('ok',ok)),'[]'::jsonb)::text AS permission_report, bool_and(ok) AS permissions_ok FROM diagnostics \\gset",
        "SELECT :'permission_report'::jsonb AS acceptance_permissions;",
        "\\if :permissions_ok", "\\else",
        "DO $$ BEGIN RAISE EXCEPTION 'Acceptance permissions blocked; inspect the complete acceptance_permissions report above'; END $$;",
        "\\endif",
    ]


def grant_sql(checks):
    """Grant only the reviewed relations actually created by this transaction."""
    def array(names):
        return 'ARRAY[' + ','.join("'{}'".format(x) for x in sorted(names)) + ']::text[]'
    def actual(kinds):
        return "ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ({}) AND NOT c.oid::bigint=ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('dx_acceptance.before_relations')::jsonb)::bigint)) ORDER BY c.relname)".format(kinds)
    result = ["DO $$ BEGIN IF " + actual("'r','p'") + " IS DISTINCT FROM " + array(checks['creates']) + " OR " + actual("'S'") + " IS DISTINCT FROM " + array([x['name'] for x in checks['sequences']]) + " THEN RAISE EXCEPTION 'Created relations differ from checksum-bound grant inventory'; END IF; END $$;"]
    for name in checks['creates']:
        result.append("DO $$ BEGIN IF (SELECT relowner FROM pg_class WHERE oid='public.{}'::regclass)<>current_user::regrole THEN RAISE EXCEPTION 'New relation is not owned by the migration role'; END IF; END $$;".format(name))
        result.append("GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.{} TO dx_rework_acceptance_app;".format(name))
        allowed = ' AND '.join("has_table_privilege('dx_rework_acceptance_app','public.{}','{}')".format(name, privilege) for privilege in ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        result.append("DO $$ BEGIN IF NOT ({}) THEN RAISE EXCEPTION 'New table application grant failed'; END IF; END $$;".format(allowed))
    for seq in checks['sequences']:
        result.append("DO $$ BEGIN IF pg_get_serial_sequence('public.{table}','{column}')::regclass IS DISTINCT FROM 'public.{name}'::regclass THEN RAISE EXCEPTION 'Sequence dependency differs from grant inventory'; END IF; END $$;".format(**seq))
        result.append("GRANT SELECT ON SEQUENCE public.{} TO dx_rework_acceptance_app;".format(seq['name']))
        result.append("DO $$ BEGIN IF NOT has_sequence_privilege('dx_rework_acceptance_app','public.{}','SELECT') THEN RAISE EXCEPTION 'New sequence backup grant failed'; END IF; END $$;".format(seq['name']))
    return result


def history_validation_sql(command, mode):
    # Backtick substitution works in psql13. Reset first, then require the exact
    # success signal from the validator; failure/empty/missing output is fatal.
    signal_command = command + ' ' + mode + ' --psql-signal'
    if any(char in signal_command for char in ('`', '\n', '\r')):
        raise ValueError('Invalid history validation command')
    return ["\\set acceptance_history_signal ''",
            "\\set acceptance_history_signal `" + signal_command + "`",
            "SELECT 1 / CASE WHEN :'acceptance_history_signal'='DX_ACCEPTANCE_HISTORY_VALID' THEN 1 ELSE 0 END;"]


def compatibility_sql(source, tool_root, row):
    policy = json.loads((tool_root / 'scripts/deploy/migration-execution-compatibility.json').read_text())
    check = policy.get(row['version'])
    if check is None:
        return None
    sql = (source / 'apps/api/migrations' / (row['version'] + '.sql')).read_text()
    if check['checksum'] != row['checksum'] or sql.count(check['replace']) != 1:
        raise ValueError('Frozen migration compatibility binding drift')
    adapted = sql.replace(check['replace'], check['with'])
    if hashlib.sha256(adapted.encode()).hexdigest() != check['executionChecksum']:
        raise ValueError('Migration compatibility execution checksum drift')
    return adapted


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
    for check in requirements.values():
        for key in ['tables', 'functions', 'references', 'insert', 'update', 'creates', 'execute']:
            if not isinstance(check.get(key), list) or any(not isinstance(x, str) or not re.fullmatch(r'[a-z][a-z0-9_]*', x) for x in check[key]):
                raise ValueError('Invalid permission inventory identifiers')
        if not isinstance(check.get('sequences'), list):
            raise ValueError('Sequence inventory is required, including an explicit empty list')
        for seq in check['sequences']:
            if set(seq) != {'name', 'table', 'column'} or any(not isinstance(x, str) or not re.fullmatch(r'[a-z][a-z0-9_]*', x) for x in seq.values()) or seq['table'] not in check['creates'] + check['tables']:
                raise ValueError('Invalid sequence permission inventory')
    seen = set()
    for row in entries:
        version, checksum = row['version'], row['checksum']
        if not re.fullmatch(r'[0-9]{4}_[a-z0-9_]+', version) or not re.fullmatch(r'[0-9a-f]{64}', checksum) or version in seen:
            raise ValueError('Invalid or duplicate migration identity')
        seen.add(version)
        file = source / 'apps/api/migrations' / (version + '.sql')
        if hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            raise ValueError('Git SQL/manifest checksum drift: ' + version)
        compatibility_sql(source, tool_root, row)
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
           "DO $$ BEGIN IF current_setting('server_version_num')::integer<130000 THEN RAISE EXCEPTION 'PostgreSQL 13 or newer required'; END IF; END $$;",
           "SELECT pg_advisory_lock(hashtext('dx-rework-schema-migrations'));", "BEGIN READ ONLY;", export,
           *history_validation_sql(command, 'prefix')]
    sql += permission_sql(entries, requirements) + ['COMMIT;']
    if mode == 'apply':
        for row in entries:
            version, checksum = row['version'], row['checksum']
            file = source / 'apps/api/migrations' / (version + '.sql')
            sql.extend([f"SELECT NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{version}') AS pending \\gset",
                        "\\if :pending", "BEGIN;",
                        "SELECT set_config('dx_acceptance.before_relations',(SELECT coalesce(jsonb_agg(c.oid::bigint),'[]'::jsonb)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S')),true);",
                        ])
            adapted = compatibility_sql(source, tool_root, row)
            if adapted is None:
                sql.append("\\ir " + shlex.quote(str(file)))
            else:
                sql.extend(["SELECT current_setting('server_version_num')::integer>=150000 AS native_migration_sql \\gset",
                            "\\if :native_migration_sql", "\\ir " + shlex.quote(str(file)),
                            "\\else", adapted, "\\endif"])
            checks = requirements.get(version)
            if checks is not None and checks['checksum'] == checksum:
                sql.extend(grant_sql(checks))
            sql.extend([
                        f"INSERT INTO schema_migrations(version,checksum) VALUES('{version}','{checksum}');",
                        "COMMIT;", "\\endif"])
        sql.extend([export, *history_validation_sql(command, 'current')])
    sql.append("SELECT pg_advisory_unlock(hashtext('dx-rework-schema-migrations'));")
    return '\n'.join(sql) + '\n'


if __name__ == '__main__':
    source, identity, node, history, output, mode, tool_root = sys.argv[1:]
    Path(output).write_text(generate(source, json.loads(Path(identity).read_text()), node, history, mode, tool_root))
