# Connection disclosure correction — 2026-11-06

Base: `ba9995c362a180939c8cc1e9acf1e980b5bd17fc` on UI main.
Reviewed tracked diff: `/tmp/expiring-collapse-review.diff`, SHA256 `8c3ae7cea8e0ac45aa04a9cd638a5b7674126d07e9d54fcd1ccefd26e4d26314`. No production code changes after review; added a narrow scrolled-into-view screenshot assertion to the browser harness; README, gallery formatting and this acceptance record are supporting documentation.

## Verbatim correction delegation (Hatchet)

> Boss reports new autoUseExpiringResets toggle is correctly located but 'doesnt hide like the rest of the connection'—visibility/collapse behavior mismatches existing selected connection controls. Please investigate current UI exact containment/visibility vs sibling connection fields; fix smallest existing-pattern defect, regression test relevant hide/collapse behavior, verify visually, fresh independent review and normal publication. Preserve unrelated edits. No new panels/layout. Coordinate exact SHA and evidence; do not change live settings. User's complaint in implementation context is correction to delivered feature.

Original feature request and constraints are retained in `../acceptance.md`.

## Finding and correction

Toggle/helper were adjacent siblings after the existing `#models-connection-fields[hidden]`, outside the disclosure that contains Provider/API/URL/OAuth controls. Move the same existing block inside that wrapper. Add its row class to the existing full-span grid selector so expanded width is preserved. No new panel, field behavior, API contract, eligibility, state, manual reset behavior, or layout system.

## Verification

- Red regressions against delivered component: 3 failed / 9 passed (`/tmp/expiring-collapse-red.log`).
- Final focused: 28 passed / 3 files (`/tmp/expiring-collapse-focused-final.log`); shared hide/reopen and mounted draft, helper containment, account switch/default value, discovery recovery open and successful re-collapse, saved-setting/error/dirty-guard tests retained.
- Full suite: 211 files / 2054 passed, exit 0 (`/tmp/expiring-collapse-full.log`). This first full run preceded only the final full-width row class/selector; final focused/build/browser then passed on that addition. Final full run also passed 211 files / 2054 tests, exit 0 (`/tmp/expiring-collapse-full-final.log` and `.exit`), after the geometry adjustment.
- Final production build passed (`/tmp/expiring-collapse-build-final.log`, `/tmp/expiring-collapse-final.exit=0`). Existing >500kB chunk advisory remains.
- Owned real Chromium fixture passed (`browser.json`, `/tmp/expiring-collapse-browser.log`): 1366/1000/480 collapsed/expanded before/after, hidden draft preserved, switch re-collapses, expanded row full width, default off, explicit true/false mock save/reselect, failed Save preserves draft, dirty guard, account isolation, Anthropic/API/LB exclusions, no page horizontal overflow, narrow toggle scroll-reachable, no browser exceptions. Network limited to fixture static resources; no real settings or redemption requests.
- Smatchet directly inspected actual expanded/collapsed rendered fixture and final paired gallery PNGs with Goblin-DevTools. Shared controls and models stay usable; expanded row stays full width; collapsed toggle/helper disappear without leaving a panel; save/error/focus/guard screenshots show no new defect.

- CI-covered tracked-source formatting passed (`/tmp/expiring-collapse-ci-format.log`, exit 0); an extra broad all-tracked JSON check flagged unchanged `docs/burrow.postman_collection.json`, outside npm format:check scope. Left unrelated documentation untouched.

## Independent review

Fresh `gpt-6-luna`, `subagent-1793990652385-97278faf`, verified exact base/diff hash read-only. Functional correctness/regressions PASS. Code scope correct; visual portion INSUFFICIENT because reviewer could inventory but not render screenshot pixels. Did not rerun supplied tests. No source defects found. Do not mislabel this as Luna visual approval.

Hatchet separately directly inspected rendered paired gallery and replied:

> Independently inspected the rendered paired gallery. **Visual PASS for the disclosure correction shown:**
> - Collapsed reset controls disappear at 1366/1000/480.
> - Expanded layout retains the existing field width and arrangement.
> - Save/error, enabled-focus, and unsaved-change states show no evident new layout defect.
> Preserve Luna’s result accurately: **functional PASS; visual insufficient evidence due to image-rendering limitation**, supplemented by my direct gallery inspection—not a retroactive Luna visual pass.
> Finish your screenshot acceptance, retain both review records with the candidate evidence, then follow the already-authorized normal publication path. Send the exact UI SHA and downstream CI reference for the watch. No live changes implied.

## Publication boundary

Normal explicit-file UI main commit/push and remote verification. Downstream normal CI/assembly is coordinated with Hatchet's CI watch, not a claim of installed-runtime deployment. No live settings changes or shared-service restarts.
