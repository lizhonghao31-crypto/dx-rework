#!/usr/bin/env bash
# Dedicated hosted job and disposable local test DB. This never consumes a
# deployment/production connection and retains the canonical low-privilege role.
set -euo pipefail
container=dx-rework-affected-entry-postgres
docker run --rm -d --name "$container" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres_ci \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1:5432:5432 postgres:16-alpine
ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=$((ready+1))
    if [[ "$ready" -ge 3 ]]; then break; fi
  else
    ready=0
  fi
  sleep 1
done
if [[ "$ready" -lt 3 ]]; then docker logs "$container"; exit 1; fi
psql_ci() { docker exec "$container" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -c "$2"; }
psql_ci postgres "CREATE ROLE dx_rework_test LOGIN PASSWORD 'dx_rework_ci' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
for db in dx_rework_ci dx_rework_acceptance_clock_test; do
  psql_ci postgres "CREATE DATABASE $db OWNER dx_rework_test"
  psql_ci postgres "COMMENT ON DATABASE $db IS 'dx-rework-isolated-test-v1'"
done
psql_ci dx_rework_ci "CREATE ROLE dx_rework_acceptance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE"
psql_ci dx_rework_ci "CREATE ROLE dx_rework_acceptance_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE"
psql_ci dx_rework_ci "GRANT dx_rework_acceptance, dx_rework_acceptance_app TO dx_rework_test"
test_url='postgresql://dx_rework_test:dx_rework_ci@127.0.0.1:5432/dx_rework_ci'
NODE_ENV=test TEST_DATABASE_URL="$test_url" node scripts/test-database-safety.mjs
{
  echo "TEST_DATABASE_URL=$test_url"
  echo "ACCEPTANCE_CLOCK_TEST_DATABASE_URL=postgresql://dx_rework_test:dx_rework_ci@127.0.0.1:5432/dx_rework_acceptance_clock_test"
} >> "$GITHUB_ENV"
