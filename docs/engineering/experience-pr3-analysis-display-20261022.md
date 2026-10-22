# Experience PR3: restore analysis context and distinguish unavailable statistics

Independent release base121c992fa77a175bcd44c2483d22020c18fdd99d. Scope A05/B01 only. No schema, quantity/money calculation, business-write, permissions, shared navigation semantics or cockpit-layout changes. QUICK: App only passes the existing location object into this specific analysis page; other hosts are unchanged. No separate paid Review is requested for this bounded read-only UI change.

The analysis page follows router location entries, including same-path saved-record links and back/forward. It parses the existing filter schema, restores filters/view/page, clears selected evidence and stale data, and performs the current read even when saved filters equal the current query. Typed filters keep their existing replaceState behavior and do not invalidate themselves. The existing response live guard rejects late old-filter reads. A saved record's original asOf/rule metadata remains historical evidence; its restored filters fetch current data and do not pretend to reconstruct an old snapshot.

Receiving cards show unavailable placeholders with neutral styling during load, rejected/failed reads or invalid targets. A valid successful empty result still shows0 and its normal meaning. Existing input, error text, read-only retry, late-response guard and data rules remain intact. No synchronization repair, supplier total rewrite or original data mutation is attempted.

Local verification: real production main.tsx/App/internal navigation/analysis/receiving pages with a synthetic localhost HTTP server. Seven cases cover saved-filter restoration, repeated same-filter current read, view/page/back/forward synchronization, late-filter response/no loop, initial loading then valid zero,503 recovery,403 refusal, invalid date input and correction, prior-success refresh failure, and late success after a newer rejection. No writes or external requests occur. Typecheck/lint pass; complete local Vitest2666 passed,632 conditional skips.

Early browser harness failures were hidden-details innerText and an incorrect expectation after intentionally pushing two identical history entries. They were corrected without relaxing the product assertions. A same-filter navigation edge exposed during this work was fixed by scheduling its fresh read. Original failed logs remain local.

The required remote gate must use the final published Head; it is pending the account Actions-budget decision. Local synthetic browser results are not Acceptance deployment or live-data acceptance.
