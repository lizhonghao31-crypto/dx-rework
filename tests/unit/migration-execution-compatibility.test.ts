import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';
import policy from '../../scripts/deploy/migration-execution-compatibility.json';

const version='0236_factory_remainder_executions';
const sql=readFileSync(`apps/api/migrations/${version}.sql`,'utf8');
const migration={version,checksum:policy[version].checksum,sql};
describe('frozen PG13 migration execution compatibility',()=>{
 it('changes only the exact unsupported statement on PG13/14',()=>{
  for(const server of [130023,140000])expect(migrationExecutionSql(migration,server)).toBe(sql.replace(policy[version].replace,policy[version].with));
  for(const server of [150000,160000])expect(migrationExecutionSql(migration,server)).toBe(sql);
 });
 it('rejects a changed frozen SQL, checksum or unknown server',()=>{
  expect(()=>migrationExecutionSql({...migration,sql:sql+'\n'},130023)).toThrow('binding drift');
  expect(()=>migrationExecutionSql({...migration,checksum:'0'.repeat(64)},130023)).toThrow('binding drift');
  for(const server of [NaN,120000])expect(()=>migrationExecutionSql(migration,server)).toThrow('server version');
 });
 it('keeps existing SQL, manifest and permission fingerprint identical',()=>{
  const manifest=JSON.parse(readFileSync('apps/api/src/platform/migration-manifest.json','utf8'));
  const permissions=JSON.parse(readFileSync('scripts/deploy/acceptance-migration-requirements.json','utf8'));
  expect(manifest.migrations.find((row:{version:string})=>row.version===version).checksum).toBe(migration.checksum);
  expect(permissions[version].checksum).toBe(migration.checksum);
 });
});
