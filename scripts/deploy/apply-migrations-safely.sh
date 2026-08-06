#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# == 2 ]] || die 'usage: apply-migrations-safely.sh API_DIR CURRENT_DATABASE_STATE'
api="$(realpath "$1")"
current_before="$2"
[[ -d "$api" && ! -L "$api" ]] || die 'installed API release required for migration'
: "${DATABASE_URL:?DATABASE_URL required}"

migration_rc=0
(cd "$api" && DATABASE_URL="$DATABASE_URL" node_exec scripts/migrate.mjs) || migration_rc=$?
if (( migration_rc == 0 )); then
  safe_log pass 'all pending migrations applied'
  exit 0
fi

if ! current_after="$(DATABASE_URL="$DATABASE_URL" node_exec \
  "$api/scripts/deploy/database-state.mjs" print-current)"; then
  enter_release_maintenance
  die 'migration failed and database state is unreadable; maintenance enabled and manual recovery is required'
fi

if database_states_equal "$current_before" "$current_after"; then
  safe_log fail 'migration failed before database state changed; previous release remains active'
  exit "$migration_rc"
fi

# Migrations commit independently. Once any earlier migration has landed, the
# previous application may no longer be compatible even though activation has
# not started. Block external traffic until a forward-fix or approved database
# recovery completes.
enter_release_maintenance
safe_log fail 'migration failed after a partial database change; maintenance enabled and manual recovery is required'
exit "$migration_rc"
