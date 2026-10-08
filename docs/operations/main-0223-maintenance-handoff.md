# Main 0223 maintenance admission

The main application requires `0223_sourcing_factory_change_craft_names`, SHA256
`a374629a47ed1c233816ad98083f6de924f0964eb7c3ef2dbca184dc1d8b44d0`.
The installed controller must contain the exact approved maintenance plan. Online
updates still admit identical complete migration histories only.

Before traffic changes, the maintenance checker requires ownership of
`public.craft_catalog_versions` and its TRIGGER privilege, ownership or inherited ownership of
`public.guard_craft_catalog_version_creation()`, `public` as the current schema
with USAGE and CREATE, and plpgsql USAGE. These checks use a read-only transaction.
The checker never grants permissions or changes an owner. A permission failure
must be resolved through separately approved database administration.

Install main tools explicitly from a clean, audited checkout at the final merged
main tool SHA, using the already approved settings:

```bash
bash "$APPROVED_MAIN_CHECKOUT/scripts/deploy/install-online-entry.sh" \
  "$(cat /opt/dx-rework-release-state/node-binary)" \
  "$(cat /opt/dx-rework-release-state/nginx-config)"
```

Verify the checkout HEAD and clean status before installation. The installer
archives that exact SHA to `/opt/dx-rework-release-tools/<SHA>` and pins the main
launchers to it. Fetching application main does not refresh the controller's
executable policy. Do not use a data-only refresh to admit this checker change.
Acceptance tools remain a separate audited release revision; when installing
both entries, pass the final main and release SHAs explicitly to the existing
`install-update-entries.sh`. Never substitute a moving release branch or merge
the two application branches.

Application candidate selection is distinct from tool installation. The current
maintenance entry fetches main on its first preparation and has no CLI argument
for an initially requested application SHA. Verify the approved remote main SHA
and hold further main changes during that first preparation. Once prepared, the
controller records `candidate-sha` and `previous-active.json` under
`/opt/dx-rework-release-state` before maintenance routing. Recovery uses that
frozen candidate and reconstructs the exact previous served SHA; never edit the
journal or run the online entry to bypass a pending migration.

The operator runs `dx-rework-maintenance-update` for this schema change. Failed
transactional DDL can restore the old runtime only if its entire migration
history still matches. After committed DDL, startup/activation failure retains
maintenance and retries the same frozen candidate. A same-schema update after
completion returns to the normal `dx-rework-update main` entry.

Reproduce the PG13 checks only on a fresh disposable database marked
`dx-rework-isolated-test-v1`, with the test role explicitly lacking all cluster
privileges and `TEST_ADMIN_DATABASE_URL` pointing to the same local test database:

```bash
NODE_ENV=test node tests/fixtures/main-maintenance-plan-pg13.mjs
```

The fixture applies the real 0222 prefix and 0223 as the restricted role, exercises
the real Bash maintenance controller with stub runtime probes, and checks missing
plan, SQL drift, table TRIGGER/function/schema/language permissions, unchanged-history recovery,
post-commit maintenance, frozen-candidate retry and zero second migration apply.
Its temporary ACL/owner changes are confined to the marked disposable test
database; it does not prove real ECS installation or production HTTP readiness.
