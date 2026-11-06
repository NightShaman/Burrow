# Expiring reset toggle — acceptance

Base: `8ce9c0d86d6833259c30b2be9d1ae19b471918be`.
Final tracked source diff: `/tmp/expiring-ui-review-final.diff`, SHA256 `f018f1ac333a2b9cd7f87fbfeb72472577cf16e338c7c917a52573f99cc4cfea`, plus new feature tests and fixture directory. Production source unchanged after review. Gallery and this acceptance record added/updated afterward.

## Original delegated request

> Boss now authorizes IMPLEMENT + normal coordinated publication OAuth auto-use expiring reset credits. Own UI: normal existing-style toggle selected direct OpenAI OAuth connection settings ONLY, not LB. Label Automatically use expiring resets; helper uses banked credits within5min expiry backend even browser closed; manual unchanged. Please inspect existing connection config persistence and propose minimal boolean contract to me immediately, then implement UI/tests/browser+fresh Luna review. Preserve concurrent edits; no push until exact pair coordination. Backend delegated separately. No real redemption/live settings changes.

## Subsequent publication authorization

> Backend candidate done realPG177+manual32pass freshLuna no actionable issue. Contract autoUseExpiringResets works auth omitted truefalse freshstore, directonly. Please resolve full-suite polling teardown errors (verify test artifact vs defect), finish independent visual via your direct browser inspection acceptable with Luna functional separate limitation; commit explicit UI files then PUSH normalCI now. Return SHA exact files/test evidence and gallery URL for my inspection if available. Parent publishing backend next; no live changes.

## Contract and scope

Top-level optional `autoUseExpiringResets: boolean`; missing is false. Only eligible selected direct OpenAI Responses OAuth connections expose/send it. Uses existing normal Save and dirty/discard behavior. No load-balancing control or manual-reset changes. Backend verification is Hatchet's reported evidence, not established by this mocked UI fixture.

## Verification

- Focused suite: 73 passed / 5 files (`/tmp/expiring-focused-tests.log`), including 10 new feature cases and 3 dashboard hydration cases.
- Production build: `npm run build` passed exit 0 (`/tmp/expiring-build-final.log`, `.exit`).
- Final full suite: `npm test -- --maxWorkers=4` **2052 passed / 211 files, exit 0, no unhandled errors** (`/tmp/expiring-all-tests-serial.log`, `.exit`). This is a complete run with bounded parallelism, not skipped tests.
- CI-covered tracked-file formatting passed (`/tmp/expiring-ci-format.log`). Broad local `npm run format:check` initially encountered ignored generated fixture builds and an unrelated ignored Menagerie fixture; those are not publication inputs. Clean candidate format/build verification is recorded separately in the publication handoff.
- Actual isolated Chromium interaction checks passed; `browser.json` records default off, focus, mocked save error/retry, reselect persistence, explicit disable, account isolation, API/Anthropic/pool exclusions, and no page horizontal overflow at 1366/1000/480 widths. No real settings writes or reset redemption.
- Smatchet directly inspected rendered desktop 1366×900 and narrow 480×900 via Goblin-DevTools, including actual accessibility tree and current screenshots on 2026-11-06 at 18:09 UTC. Existing switch styling, label/helper, hierarchy and buttons fit. Same-shell before/after and changed/error states are retained here. This is builder visual acceptance, separately accepted by Hatchet, not an independent image-reading claim.

## Polling teardown investigation

Initial full run: 2052 assertions passed but exit 1 with three unhandled `window is not defined` errors in chat poll callbacks after jsdom teardown (`/tmp/expiring-all-tests.log`). Vitest globals are disabled; RTL auto-cleanup registers only when global afterEach exists. `useChatSession.test.tsx` did not register explicit cleanup, leaving rendered hooks and background pollers mounted. Added test-only `afterEach(cleanup)` to unmount through the production cleanup paths; no production chat code or error suppression changed.

Unmodified HEAD was tested from `/tmp/expiring-ui-baseline-rA7b1z`: isolated chat 62 passed; full suite completed with one unrelated App.editAgent timeout and no polling errors. Thus the exact original polling error was not reproduced on baseline and is not claimed conclusively pre-existing. During overlapping baseline/candidate full runs, timing tests failed; these failed runs remain recorded (`/tmp/expiring-full-baseline.log`, `/tmp/expiring-all-tests-fixed.log`). The final uncontended bounded-worker suite passed all 2052 tests, with no unhandled errors. Source evidence identifies a test lifecycle defect, not an expiring-reset production path.

## Fresh independent review

First reviewer: requested model `gpt-6-luna`, ID `subagent-1793987716822-bf57f0ba`: no evidenced source defects; backend/independent rendering insufficient evidence.

Final reviewer: requested model `gpt-6-luna`, ID `subagent-1793988594600-75fedf50`, reviewed final diff hash above plus new feature tests/fixture:

- Functional/UI contract: PASS; default-off, eligibility, payload, draft/discard and manual reset scope supported.
- Scope/layout/behavior: PASS for supplied UI/browser evidence, with no independent PNG visual inspection claimed. Backend remains Hatchet's separate evidence.
- Test cleanup: correctly scoped, no suppression or production change. Reviewer independently ran chat tests: 62 passed exit 0.
- At review time full runs were incomplete/failing under contention, so reviewer correctly left full-suite acceptance insufficient. The completed clean final run above resolves that test-evidence gap without source changes after review.

## Publication

Hatchet authorized immediate explicit-file UI commit and normal-CI push while separately publishing the backend. No deployment, restart, real redemption, or live settings mutation is authorized or performed here.

Gallery: `http://10.10.20.105:43344/gallery.html` (temporary owned read-only fixture server). Interactive candidate: `http://10.10.20.105:43343/`.
