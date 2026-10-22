import branches from './migration-branches.json' with { type: 'json' };
import mainExtensions from './migration-main-extensions.json' with { type: 'json' };

const commonCount = 217;
const known = [...branches.main, ...branches.digital];
const approved = [...known,...mainExtensions];
const knownByVersion = new Map(approved.map(row => [row.version, row.checksum]));
const approvedByPrefix = new Map();
for (const row of approved) {
  const prefix = Number(row.version.slice(0, 4));
  approvedByPrefix.set(prefix, [...(approvedByPrefix.get(prefix) ?? []), row]);
}
const pairedPrefixes = new Set([...approvedByPrefix].filter(([, rows]) => rows.length === 2).map(([prefix]) => prefix));

function assertPrefix(applied, expected) {
  if (applied.length > expected.length) {
    throw new Error(`Applied migration is absent from Head manifest: ${applied[expected.length]?.version ?? 'unknown'}`);
  }
  for (const [index, actual] of applied.entries()) {
    const target = expected[index];
    if (!target || actual.version !== target.version) {
      throw new Error(`Applied migration history diverged at position ${index + 1}: actual=${actual.version}, expected=${target?.version ?? 'missing'}`);
    }
    if (actual.checksum !== target.checksum) throw new Error(`Migration checksum drift detected: ${actual.version}`);
  }
}

// Only the frozen 2026-09 histories and explicitly checksummed main extension may have independent prefixes.
// No historical row is renamed, deleted, re-checksummed, or marked applied for free.
export function assertAppliedMigrationHistory(applied, expected) {
  const target = new Map(expected.map(row => [row.version, row.checksum]));
  const reconcilesKnownBranches = known.every(row => target.get(row.version) === row.checksum);
  if (!reconcilesKnownBranches) return assertPrefix(applied, expected);
  const seen = new Set();
  for (const actual of applied) {
    if (!target.has(actual.version)) throw new Error(`Applied migration is absent from Head manifest: ${actual.version}`);
    if (seen.has(actual.version)) throw new Error(`Duplicate applied migration: ${actual.version}`);
    seen.add(actual.version);
    if (actual.checksum !== target.get(actual.version)) throw new Error(`Migration checksum drift detected: ${actual.version}`);
  }
  const common = expected.slice(0, commonCount);
  const commonApplied = applied.filter(row => Number(row.version.slice(0, 4)) <= commonCount);
  assertPrefix(commonApplied, common);
  if (applied.length === commonApplied.length) return;
  if (commonApplied.length !== commonCount) throw new Error('Branch migrations require the complete shared history');
  for (const lane of [[...branches.main,...mainExtensions],branches.digital]) {
    const versions = new Set(lane.map(row => row.version));
    assertPrefix(applied.filter(row => versions.has(row.version)), lane);
  }
  const later = expected.filter(row => Number(row.version.slice(0, 4)) > 231);
  const laterApplied = applied.filter(row => Number(row.version.slice(0, 4)) > 231);
  if (laterApplied.length && !known.every(row => seen.has(row.version))) {
    throw new Error('Post-reconciliation migrations require both complete branch histories');
  }
  assertPrefix(laterApplied, later);
  // The 0251 bridge belongs after these exact main extensions. Older release
  // histories remain valid prefixes; future extensions do not invalidate 0251.
  if (seen.has('0251_contract_price_acceptance_bridge') &&
    !['0228_sourcing_contract_return_cycles','0229_sourcing_price_reapplications'].every(version => seen.has(version))) {
    throw new Error('Contract price bridge requires both original main migration histories');
  }
  // Reject any unexpected migration masquerading as a third fork in 0218..0231.
  for (const row of applied) {
    const n = Number(row.version.slice(0, 4));
    if (n > commonCount && n <= 231 && !knownByVersion.has(row.version)) {
      throw new Error(`Unknown migration branch: ${row.version}`);
    }
  }
}

export function assertMigrationSequence(migrations) {
  let next = 1;
  const seen = new Set();
  const counts = new Map();
  for (const row of migrations) {
    if (seen.has(row.version)) throw new Error(`Duplicate migration version: ${row.version}`);
    seen.add(row.version);
    const prefix = Number(row.version.slice(0, 4));
    if (knownByVersion.has(row.version) && knownByVersion.get(row.version) !== row.checksum) {
      throw new Error(`Frozen branch migration checksum drift: ${row.version}`);
    }
    if (prefix === next) next += 1;
    else if (!(prefix === next - 1 && pairedPrefixes.has(prefix)
      && knownByVersion.get(row.version) === row.checksum && counts.get(prefix) === 1)) {
      throw new Error(`Migration sequence gap or unapproved duplicate: expected ${String(next).padStart(4, '0')}, found ${row.version}`);
    }
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  // A duplicate prefix is valid only for the exact pair of frozen migrations.
  for (const [prefix, count] of counts) if (count > 1) {
    const pair = approved.filter(row => Number(row.version.slice(0, 4)) === prefix);
    if (pair.length !== count || !pair.every(row => seen.has(row.version))) {
      throw new Error(`Unapproved migration prefix collision: ${prefix}`);
    }
  }
}
