# Main release entry and recovery

This change installs a small root controller around the existing packaging, migration,
PM2 and nginx tools. It does not deploy itself. The initial installer takes an audited
clean checkout, an approved root-owned Node 22 binary, and the existing dedicated
nginx vhost path. Installation saves the old deploy entry/configuration and does not
reload nginx or change the running API. Repeat installation is idempotent.

After the corresponding Acceptance update-entry change is installed, normal commands
are `sudo dx-rework-update main` and `sudo dx-rework-update acceptance`. The main
entry prepares an independent complete remote snapshot using the existing SSH
identity; it never clones the production partial/promisor working tree. It builds
while the active API serves, verifies the entire applied migration history against
the candidate, starts the other port, and checks local readiness, protocol and SHA.

For identical migration histories, nginx switches its dedicated vhost to a generation
that binds both the frontend and backend. The root controller validates nginx before
reload and checks the public TLS route. Old nginx workers finish accepted requests
before their API is stopped. A failed public probe restores the previous same-schema
application generation, drains candidate workers, and verifies the public old SHA.
No database restore happens in an online rollback. A persistent phase journal allows
the same fixed entry to resume interrupted switches; a pending drain retains both
processes rather than killing an accepted request.

Background monitoring, todo processing, attachment cleanup and contract resumption
run only in the process holding an OS flock. Shutdown waits for its background work
and HTTP close before releasing ownership. A crash releases the lock for the next
process. This provides one live executor; it does not make external effects exactly
once after arbitrary process or provider failures.

## Schema changes and the first 0222 installation

Different full migration histories are refused before switching or stopping the
running service. The separate fixed `sudo dx-rework-maintenance-update` entry is an
explicit controlled maintenance operation, not an automatic fallback. It refuses
unreviewed pending SQL. The initial approved plan contains only migration 0222 and
its exact checksum; historical files are not renamed or rewritten.

For that operation, the candidate and exact old recovery artifact are built first.
Then new production requests receive maintenance 503, accepted nginx requests drain,
and the old runtime stops. Only then is a quiescent backup made. Migration advisory
locks are nonblocking; table locks wait at most 2 seconds, statements 60 seconds,
and client/process waits are bounded. A lock conflict rolls back the transaction.
If the whole old migration history still matches, the old runtime may recover.
After any committed schema change, the controller retains maintenance and retries
the frozen new candidate; it never starts an incompatible old API or restores a
backup over acknowledged orders. The first 0222 upgrade therefore requires a
maintenance window and cannot be described as zero downtime.

The dedicated vhost reload uses the existing nginx master. Other vhosts are not
edited, but nginx validates/reloads its complete configuration. Direct connections
that bypass nginx, hostile network/provider failures, and arbitrary host shutdowns
are outside the nginx accepted-request drain guarantee. Long requests can postpone
completion; the 300-second drain bound retains service and reports a pending state.

## Verification

`tests/integration/safe-migration-locks-postgres.test.ts` runs the actual 0222 SQL
against isolated PostgreSQL 13 with advisory/table contention and checks transaction
rollback, immutable historical timestamps and idempotent completion.
`background-lease-process.test.ts` uses independent processes, graceful drain and
SIGKILL to verify single ownership and transfer.

`tests/fixtures/online-release-nginx-exercise.mjs` is restricted to a disposable root
container and a marked nonprivileged test database. It runs the real compiled API,
PM2, nginx TLS and QC HTTP/idempotency routes. Synthetic generation labels and the
existing isolated Acceptance identity provider prevent external provider calls.
It holds a real database advisory lock inside accepted writes during successful
switch and public-probe failure rollback, then replays acknowledged keys and checks
one persisted order per key. This exercises the root switch journal, not production
SSH identity, actual ECS installation. With `DX_RELEASE_HISTORICAL=1` and an independently built exact b7d400e6 checkout at `/workspace/dx-historical-main`, the same fixture runs the real old application at schema0221, recovers from a denied backup and an actual 0222 DDL lock conflict, then completes 0222 and verifies historical migration receipts and HTTP idempotency. All provider identity is isolated and the new generation label remains synthetic.

`install-update-entries.sh MAIN_SHA ACCEPTANCE_SHA APPROVED_NODE_BINARY EXISTING_DEDICATED_NGINX_CONFIG` installs both audited entries from a complete authenticated remote fetch. It rejects an unclean or mismatched starting checkout, binds explicit revisions to their branches, and may be repeated after a partial installation. It never executes arbitrary branch HEAD as an installer.

Before giving an exact one-time production installation command, resolve the final
merged audited main/release SHAs, approved Node binary and dedicated nginx path.
The user executes installation/deployment after reviewing the maintenance boundary;
this PR neither merges nor changes live configuration.
