import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Acceptance owner maintenance generator', () => {
  it('pins the local live identity, drops privilege and checks history under the migration lock', () => {
    const result = execFileSync('python3', ['-B','-c', `
import importlib.util,json,pathlib
spec=importlib.util.spec_from_file_location('maintenance','scripts/deploy/prepare-acceptance-migration.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
identity={'database':'dx_rework_acceptance','port':5544,'oid':123,'address':'127.0.0.1'}
sql=m.generate(pathlib.Path.cwd(),identity,'/usr/bin/node','/tmp/history.json')
assert sql.index('SET SESSION AUTHORIZATION') < sql.index('pg_advisory_lock') < sql.index('\\\\! ')
assert "current_setting('port')::integer<>5544" in sql
assert 'SELECT 1/0;' in sql and '\\\\quit 1' not in sql
assert 'oid::bigint' in sql
assert 'BEGIN READ ONLY;' in sql
assert 'sourcing_contract_return_submissions' in sql and 'acceptance_permissions' in sql
assert 'has_table_privilege' in sql
assert 'Missing application default' not in sql
assert 'ALTER DEFAULT PRIVILEGES' not in sql
assert 'GRANT SELECT ON SEQUENCE public.digital_factory_qc_sequence_seq' in sql
assert 'GRANT USAGE' not in sql
assert 'Created relations differ from checksum-bound grant inventory' in sql
assert sql.count('BEGIN;') == len(json.load(open('apps/api/src/platform/migration-manifest.json'))['migrations'])
for change in ({'database':'production'},{'address':'192.0.2.1'},{'port':True},{'oid':True},{'oid':4294967296},{'port':0}):
    try: m.generate(pathlib.Path.cwd(),dict(identity,**change),'/usr/bin/node','/tmp/history.json')
    except ValueError: pass
    else: raise AssertionError(change)
pre=m.generate(pathlib.Path.cwd(),identity,'/usr/bin/node','/tmp/history.json','preflight')
assert '\\\\ir ' not in pre and 'BEGIN;' not in pre
assert 'sourcing_contract_return_submissions' in pre
assert 'GRANT SELECT' not in pre and 'ALTER TABLE' not in pre
print('verified')
`], { encoding: 'utf8' });
    expect(result.trim()).toBe('verified');
  });
});
