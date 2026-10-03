import {readFile} from 'node:fs/promises';
import {assertAppliedMigrationHistory, discoverValidatedMigrations} from './migration-lib.mjs';

const path = process.argv[2];
if (!path) throw new Error('Usage: check-migration-export.mjs READ_ONLY_HISTORY_EXPORT.json');
const history = JSON.parse(await readFile(path, 'utf8')).migrations;
if (!Array.isArray(history) || history.length === 0) throw new Error('Expected a non-empty exported migration history');
const target = await discoverValidatedMigrations();
assertAppliedMigrationHistory(history, target);
const applied = new Set(history.map(row => row.version));
process.stdout.write(JSON.stringify({status:'compatible', appliedCount:history.length,
  pending:target.filter(row => !applied.has(row.version)).map(row => row.version),
  target:target.at(-1).version, scope:'migration-history-only; no database was modified'})+'\n');
