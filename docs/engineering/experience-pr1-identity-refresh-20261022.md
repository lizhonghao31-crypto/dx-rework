# Experience PR1: task-entry identity refresh

Base: release/digital-production-v1 121c992fa77a175bcd44c2483d22020c18fdd99d. Scope A04 only; FULL. Independent branch, no deployment or merge authorization.

Actual App navigation from My Todos to cockpit and back previously produced 65 successful auth reads and 64 task-page mount/unmount cycles in about 2.4 seconds. A fresh page load settled normally. This is a client revalidation/invalidation loop, not evidence that every earlier live authentication delay had this cause.

Task entry still performs a no-store identity recheck, sharing an existing in-flight read. An unchanged identity no longer broadcasts global invalidation to its own parent gate. Changed identity, role/capability sets, denial, failed/cancelled reads still invalidate dependent views after the current result is published. Explicit logout and restored-page admission keep strong invalidation; stale in-flight results cannot overwrite a newer identity. No role, capability, session TTL or backend authentication changes.

A ten-second client transport bound turns a hung identity read into the existing unread-identity/retry state. This is not a business SLA, auth bypass or extended cache lifetime. Late responses are ignored. Retry remains an explicit operation.

Validation: unit coverage includes same-identity recheck/coalescing, role/capability changes, HTTP refusal/failure, cancellation, logout versus a late response, timeout and explicit retry. `tests/acceptance/task-session-navigation-browser.mjs` builds the real production main.tsx/App/AuthGate/MyTodosPage. Six local synthetic-HTTP cases cover first entry, cockpit return, internal back/forward, persisted-page admission, identity change, 401/403, failed read/retry and hung read/retry. `session-logout-browser.mjs` remains the broader logout regression. No live credentials, business database, ERP or external sends are used.

A03 external-order draft guard, C01 receipts, C04 historical todos, unrelated UI, model settings and production operations are excluded. Gate and review evidence belong to the exact published Head; local tests do not imply Acceptance deployment or human business acceptance.

Local evidence: identity units29 passed; real-App browser6 passed; Web typecheck/build and lint passed. The older session-logout-browser runner has an unrelated typography assertion (expected13px, actual11px) failing identically on the unchanged121c baseline. Both original failures are retained; no product CSS or original assertion was changed. A temporary auth-scoped replay excludes only that obsolete visual metrics line and retains all logout/cross-tab/fallback/late-response security assertions; it passes. This is not a claim that the unchanged original visual runner passed.
