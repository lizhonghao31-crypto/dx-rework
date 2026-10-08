import {createHash} from 'node:crypto';
import compatibility from './migration-execution-compatibility.json' with {type:'json'};

const digest=sql=>createHash('sha256').update(sql).digest('hex');

// The stored fingerprint remains the original immutable logical migration.
// This audited execution variant applies only before that migration is applied.
export function migrationExecutionSql(migration, serverVersion) {
  if(!Number.isInteger(serverVersion)||serverVersion<130000)throw Error('Unsupported or unknown PostgreSQL server version');
  const check=compatibility[migration.version];
  if(!check)return migration.sql;
  if(migration.checksum!==check.checksum||digest(migration.sql)!==check.checksum
    ||migration.sql.split(check.replace).length!==2)throw Error('Frozen migration compatibility binding drift');
  const adapted=migration.sql.replace(check.replace,check.with);
  if(digest(adapted)!==check.executionChecksum)throw Error('Migration compatibility execution checksum drift');
  return serverVersion<150000?adapted:migration.sql;
}
