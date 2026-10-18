# G1: retain current main history and business behavior in the release candidate

The G1 candidate90673b6342dafcd9130a5939f4c4a81f7cb84121 carried253 migrations but omitted main0226_external_revision_preserve_handler and0227_qc_other_craft. Main728007c76270614eda15635dea325b7612d7def4 has227;225 common SQL files are byte-identical. An Acceptance update correctly stopped while reading production history. Tool refresh success did not establish candidate compatibility.

This independent release repair adds the two original SQL files/checksums, exact main lane bindings and255-entry union. Approved duplicate numeric prefixes derive only from exact paired historical identities/checksums; no arbitrary duplicate, renamed identity or third fork is admitted. Existing release253 history remains a valid upgrade starting point. The numeric maximum stays0245, which alone cannot prove the two added identities are installed.

Acceptance permission inventory38 entries binds the same immutable checksums. Added owner checks are limited to the two rework relations and named guard/functions required by the actual DDL; no account memberships/default ACL or broad production grants are changed. Existing prepare-acceptance-migration.py remains the executor and validator.

The original approved main business deltas accompany the schema:0226 preserves the original responsibility handler/todo recipient and Root branch;0227 retains new-QC none/inspection/other_craft and legacyNULL boundary, process configuration/reporting, audited waiver and immutable pre-waiver history. Execution kinds, wages and settlement rules are not redesigned. Original source commits are dc1002daf82f4c8265d08d7d9ab2894cde447386 and688ff4726c8dc2e1c1767625d5197bdc87e40972. Release-specific finishing history/closure, source receiving quantity ceiling, module/Root access, worker rejection reason and returned-report context survive the small text conflicts. Main784 deployment code,802 and the15 pending ERP PRs are excluded.

## Source gate

scripts/check-main-release-compat.mjs resolves origin refs/heads/main on every invocation to a full SHA and reads actual Git SQL/manifest objects. It compares the complete main set/checksums with the exact candidate and tool commits, lane identities, checksum-bound inventory and the actual candidate history policy. --expected-main-sha rejects an advanced main; a failed run never leaves an earlier passed output record. --worktree is explicitly marked WORKTREE_NOT_DELIVERY and is only for local assembly checks.

The existing Full Gate runs the checker for release PRs with exact Head/tool and base references. The existing dx-acceptance controller also runs it before production-history export, candidate build, backup or service stop, as the repository owner with an empty environment. It reads the existing approved Node configuration without loading application credentials. Its artifact records main/candidate/tool SHA, counts, policy fingerprint and all issues. This gate proves source/history compatibility only; runtime ACL and business behavior remain separate checks.

Unit regressions cover missing either identity, SQL/checksum drift, absent/drifted inventory, unregistered lane, third same-prefix identity, tool/candidate mismatch and excess owner scope. A real temporary Git remote advances main; the checker then reads the new source, rejects the stale candidate and invalidates the old approval output. Controller tests verify failure stops before maintenance and DB credentials are not passed to the source checker.

## Isolated verification

scripts/ci/main-release-history-drill.mjs accepts no database URL. It owns a fresh labelled, loopback-only Docker container and uses current remote-main Git history plus the actual frozen release90673 history. PostgreSQL13 and16 both exercised227→255 and253→255 through the actual low-privilege preflight/apply tool; old version/checksum/applied_at and existing relation ownership/ACL remain, repeated execution adds nothing, application does not inherit maintenance privileges. Missing owners and missing/wrong inventory bindings are rejected without changing history. Original SQL is used, except the pre-existing checksum-bound PG13 execution adaptation where already required; historical file/checksum identities are untouched.

The existing Docker business regression setup separately ran full-business-chain, qc-other-craft and receiving PostgreSQL suites (92 passed), including original handler vs reviewer/Root, new and legacy QC, finishing exclusion, other-craft configuration/reporting/waiver/history and existing quantity/wage boundaries. Neither synthetic unit data nor local PostgreSQL establishes live Acceptance, real user/device usability or all possible business compatibility.

## Required tool installation and next G1 candidate

The installed verify-tool-refresh.py intentionally rejects executable policy changes with TOOL_CODE_UPGRADE_REQUIRED. This repair changes history/controller policy, so the old253-tool revision must not auto-authorize it. Do not relax that validator or ask the user to repeat90673 updates.

After parent verification and authorized release merge, freeze the actual new merged SHA and re-run the remote-main source comparison against that candidate/tool SHA. If main advanced, compare its actual new source before delivery. Use the existing audited dx-acceptance.sh install mechanism from an isolated, clean checkout of the approved SHA to install the complete immutable tool revision; do not switch or deploy the production service checkout. Verify installed TOOL_SHA and candidate SHA match, then let the user perform the controlled Acceptance update with that new freeze. This report is not an instruction to deploy an unmerged PR Head, and it does not claim the tool was installed on the user's host.

The original reviewed operator entry is `docs/operations/g1-acceptance-compat-update.sh`. Copy that file unchanged from the approved merged revision. Each command below is a separate phase; replace the placeholder with the same full merged release SHA for all four commands. A failed phase stops and must be resolved before continuing. Run the file with `bash`, never `source`:

```bash
g1_sha='REPLACE_WITH_40_CHARACTER_MERGED_RELEASE_SHA'
bash g1-acceptance-compat-update.sh check "$g1_sha"
bash g1-acceptance-compat-update.sh install "$g1_sha"
bash g1-acceptance-compat-update.sh diagnose "$g1_sha"
bash g1-acceptance-compat-update.sh update "$g1_sha"
```

The entry checks the current remote release tip and its own exact source bytes. Check/install use a disposable clean checkout, leave the production source checkout in place and compare current remote main. Install calls the existing immutable installer; diagnose/update require its exact launcher and TOOL_SHA. Update alone invokes the existing controlled Acceptance update. No command here grants permission to execute on the live host before parent verification and authorized merge.

The existing offline controller-chain fixture now passes all seven cases, including the actual reviewed check→install→diagnose→update sequence, old executable-policy refusal, both production-slot identities, entry-install rollback and an actual temporary remote-main advance rejected before any database/worker action. Database/HTTP/OS boundaries remain local doubles in this test. ECS configuration, installed host state and live service health are explicitly untested here; the isolated PostgreSQL drills above provide the separate real database evidence.

Only785/786 are merged before this repair; the remaining15 must not be advanced. G1 must be deployed and actually accepted using the new compatible freeze before G2+. No production DB/service or real Acceptance operations were performed in this engineering task. Model/strength remain unchanged.
