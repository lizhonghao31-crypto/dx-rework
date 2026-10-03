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

export function needsFrontendBuild(paths) {
  return paths.some(path=>path==='__full_build__'||path==='package-lock.json'||path==='package.json'||
    path==='tsconfig.base.json'||path.startsWith('apps/web/')||path.startsWith('packages/'));
}

export function mayReuseBackup(previous,current) {
  return previous.phase==='stopped' && current.wasStopped===true &&
    previous.sha===current.sha && previous.fingerprint===current.fingerprint &&
    previous.history===current.history;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]==='frontend') {
    process.stdout.write(String(needsFrontendBuild(readFileSync(process.argv[3],'utf8').split(/\r?\n/))));
    process.exit(0);
  }
  const [history,manifest,environment]=process.argv.slice(2);
  const result=checkHistory(JSON.parse(readFileSync(history,'utf8')),JSON.parse(readFileSync(manifest,'utf8')),environment);
  if(process.argv[5]==='current'&&result.pending.length)throw Error('Database is not current after maintenance');
  process.stdout.write(JSON.stringify(result)+'\n');
}
