import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {assertAppliedMigrationHistory,assertMigrationSequence} from '../migration-history-policy.mjs';

export function checkHistory(history,manifest,environment) {
  if(!['production','acceptance'].includes(environment))throw Error('Unknown database environment');
  if(!history || !Array.isArray(history.migrations) || !history.migrations.length) throw Error('Database history is empty or invalid');
  if(environment==='acceptance' ? history.database!=='dx_rework_acceptance' : !history.database || history.database==='dx_rework_acceptance') throw Error('Database environment mismatch');
  assertMigrationSequence(manifest.migrations);
  assertAppliedMigrationHistory(history.migrations,manifest.migrations);
  const applied=new Set(history.migrations.map(row=>row.version));
  return {environment,database:history.database,status:'compatible',applied:applied.size,
    pending:manifest.migrations.filter(row=>!applied.has(row.version)).map(row=>row.version)};
}

export function assertVersion(actual,expected) {
  if(actual.gitSha!==expected.gitSha || actual.schemaVersion!==expected.schemaVersion) throw Error('Running version does not match the candidate');
}

export function currentCandidateAction(activeSha,candidateSha,schemaCurrent,status) {
  if(activeSha!==candidateSha||!schemaCurrent)return 'update';
  if(status==='stopped')return 'activate';
  if(status==='online')return 'verify';
  throw Error('Candidate runtime is neither online nor explicitly stopped');
}

export function mayRecoverOldRuntime(status,before,after) {
  if(status!=='online'||!Array.isArray(before?.migrations)||!before.migrations.length||!Array.isArray(after?.migrations))return false;
  return JSON.stringify(before.migrations)===JSON.stringify(after.migrations);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]==='next-action') {
    const [active,candidate,current,status]=process.argv.slice(3);
    process.stdout.write(currentCandidateAction(active,candidate,current==='true',status));
    process.exit(0);
  }
  if(process.argv[2]==='recover') {
    const [status,before,after]=process.argv.slice(3);
    if(!mayRecoverOldRuntime(status,JSON.parse(readFileSync(before,'utf8')),JSON.parse(readFileSync(after,'utf8'))))throw Error('No safe automatic old-runtime recovery');
    process.exit(0);
  }
  const [history,manifest,environment]=process.argv.slice(2);
  const result=checkHistory(JSON.parse(readFileSync(history,'utf8')),JSON.parse(readFileSync(manifest,'utf8')),environment);
  if(process.argv[5]==='current'&&result.pending.length)throw Error('Database is not current after maintenance');
  process.stdout.write(process.argv[6]==='--psql-signal' ? 'DX_ACCEPTANCE_HISTORY_VALID' : JSON.stringify(result)+'\n');
}
