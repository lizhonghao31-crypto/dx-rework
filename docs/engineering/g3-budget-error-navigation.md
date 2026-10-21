# Third-group integration: budget error navigation

The Acceptance budget editor showed errors across chapters, but its document host only registered development-field navigation. Hidden budget sections were unmounted, so the generic focus helper could not find the target.

Budget errors now resolve their chapter using current draft fields and stable row IDs. Clicking an error or validating a submission reveals the owning chapter/template rows before the shared helper scrolls and focuses. Input, version, amounts, publication and access rules are unchanged. Development navigation continues through its original context callback.

Validation: `doc01-budget-validation.test.ts` covers every document/row field mapping and row reorder/deletion. `budget-error-navigation-browser.mjs` uses the actual document host/editor at desktop and narrow widths, covering the date from the fees chapter, required basic/outsourcing fields, all three row sections, invalid summary amounts, keyboard focus, retained unsaved input and zero invalid writes. Existing G1 correction browser scenarios protect development navigation and the four approved repairs. These isolated response fixtures do not substitute for deployed Acceptance UAT.

The focused regression also exposed numeric-field blur downgrading publish validation to save validation before an error click completed. Blur now retains an active publish-validation mode, so required-field navigation targets survive the click. The save/publish validators and request guards themselves are unchanged.
