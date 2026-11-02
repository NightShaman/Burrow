# Settings browser acceptance (standalone Burrow-UI)

Imports the actual Settings component and styles. Synthetic data and all API responses are in-memory; the server's CSP denies network connections. No real account, model call, or application write is possible.

Run from the standalone `Burrow-UI` repository root (no `ui/` prefix).

```sh
npm ci
node scripts/fidgit-settings-fixture/build.mjs
node scripts/fidgit-settings-fixture/headless.mjs
```

Set `CHROMIUM_BIN` to the available Chromium/Chrome executable. Evidence PNGs and `results.json` are written to `evidence/` (git-ignored), or `FIDGIT_EVIDENCE_DIR`.

Checks visible provider selection, adjacent model capabilities, unsaved Stay/Discard, 1600/1280/768/390-pixel Models layouts, simple Appearance layout, profile editor width and document selection, Skills/Mods navigation, statistics open/close, browser runtime errors and horizontal page overflow. Screenshots require visual review in addition to the automated checks.

The fixture mirrors the production App.tsx shell classes (cockpit, app navigation stack, settings category card, workspace watermark, status bar) and uses production CSS without fixture layout overrides. Acceptance also asserts a horizontal category band, inherited shell context, action-row clipping through ancestor scroll containers, and a usable Mods editor with statistics open.

Every recorded page size also checks non-overlapping shell geometry: main header, category band, workspace, status bar, subsection navigation, and agent selector. Models and profile documents include tablet 768px, intermediate 1000px, and phone 390px checkpoints.

Iteration-two matrix visits every built-in subsection at desktop, checks the common standard editing edge with explicit bounded-family exceptions, and renders a synthetic imperative extension via the actual ModSettingsHost API. Profile, Export/Import, documents, a selected skill, a selected mod, and Trace retention forms have 1600/1000/768/390px screenshots with statistics-open reserved-space geometry checks. All API responses remain synthetic, including the extension module.

Regression geometry verifies the first installed skill card is entirely inside its selection band (not hidden below filters), and the Dreams prompt textarea ends before the secondary memory controls begin. Dreams also has four-width screenshots and statistics-layout checks.

Density coverage: 17 named agents with compact selection, GitHub MCP with 45 grantable tools with varied descriptions plus a second server, first/last/all tool toggles with validated synthetic save ACKs, independent server/tool scrolling, and 17-agent rail reorder/internal scrolling. Bounded families use explicit desktop split or mobile/medium-with-statistics stacked contracts. Statistics must reserve a column above 850px or stack without overlap below; 2560px persistent statistics is checked across Continuity/documents/MCP/rails, including the 17th agent and 45th tool. Models 900/1000 stats-open nested overflow is checked.

Layout assertions are collected per checkpoint so a single bad breakpoint does
not hide later screenshots. Any collected layout failure still fails the run
with an aggregate error and is recorded in `results.json` (`geometryFailures`
and ordered checkpoint records). Browser, API and interaction failures remain
fail-fast; collecting geometry never converts a failed run into a pass.

Scheduling coverage uses twelve typed prompt jobs and twelve typed workflow
watches each for Hatchet and Thistle. Cron, Workflow events and Dreams are
checked at 1600, 1400, 1000, 768 and 390 px with statistics closed/open, plus
2560 px with statistics continuously open. First/last selection checks real
editor values, agent isolation, inventory scroll stability and ancestor-aware
field/action reachability. Scheduling geometry follows available container
width rather than assuming the viewport determines split/stack behavior.
Dream prompt/memory overlap uses rectangle intersection for both orientations.

The all-Settings audit adds 8 skills, 6 mods, 4 mod sources, 8 token metadata
records, 6 execution boundaries, 3 telemetry destinations and 6 disabled pools.
Pools deliberately have no OAuth members: the three approved provider fixtures
remain unchanged, and the UI must honestly show that unconfigured state.
API tokens exercise the real creation/inventory contract, not an invented
selected-token editor. The full subsection sweep leaves statistics open at
1600 px; family representatives also run at 2560 px. OIDC conditional fields
are inspected without saving, then the synthetic mode is reverted to None.
Selected skill assignments and expanded source settings are inspected at
1400 and 1600 px. Normalized layouts are checked by semantic composition and
actual container content width; legacy family checks only apply to legacy
layouts. Offscreen scroll content is clipped before visible-overlap checks.

The synthetic mixed-module extension exercises all four validated declarative layout
contracts (`form`, `form-inventory`, `list-detail`, `activity`) alongside empty
metadata Overview/Advanced sections that use imperative fallback. This retains
regression coverage for switching between both supported host paths. Three records populate each
inventory/detail/activity view. CI selects the third record and verifies its
editor/detail, captures each layout at 1600 px with statistics open, and checks
the inventory editor at 390 px. No extension action contacts a live service.

All extension lifecycle flows run after the built-in audits, so a host crash
cannot hide those screenshots. Failure results include window error records
and CDP Runtime.exceptionThrown diagnostics, even if React unmounts the root.
The full built-in and wide audits record per-section failures and screenshots,
then reload the synthetic page and restore statistics before the next section.
Recorded failures always fail CI at the end; recovery never marks them passed.

Models feedback regression uses ten varied models per provider (including long
labels, multimodal capabilities and a saved manual model), rather than four
uniform toy rows. At the feedback-sized 1900×981 viewport with statistics open,
the runner captures saved/collapsed, newly discovered, saved/reopened and
8-provider states. It checks compact row heights, ten rows without nested list
scrolling, at least eight visible rows, independent selection/enabling, manual
model add/delete and capability overrides surviving save/reopen. The late
8-provider injection preserves baseline three-provider tests while exercising
the full-height left provider rail and readable adjacent capability editor.
All discovery and writes stay inside the synthetic in-memory fetch handler.

The proportions follow-up adds four 1910×1025 screenshots: saved connection
and eight-provider inventory, each with statistics closed and open. Provider
cards must keep Delete alongside the name and a readable metadata line below.
Model rows must be 48–58 px with visible name and ID lines (no third modalities
row) while all ten fit the list; the capability editor
must fill its actual adjacent column without overflow or an arbitrary width cap.

Personalization combines profile/timezone on the left and themes/Browser tab on
the right. The full subsection audit visits it once, with no obsolete Operator
profile or Appearance entries. Five focused shots cover 1600/1910 px with stats
off/on and 390 px with stats on. Assertions check paired alignment, pane-filling
forms, responsive field/preview reachability and nonoverlapping stats.
Browser tab preview, blur autosave, navigation persistence and Stay/Discard
are exercised using Trace retention as the destination. Synthetic PUT retains
the suffix in memory; no production API is used. Current upstream reference-photo
coverage is described below.

Whole-area sizing comparison replaces the prior one-state audit with 62
1910×1025 screenshots: 24 built-in sections, 2 global sections and 5 extension
layout modes, each with statistics off/on. Existing wide and responsive
interaction suites are reused rather than multiplying every new combination.
Conditional OIDC/trusted-proxy, local-GGUF Curator, selected Skill source and
synthetic stored-credential browser cover otherwise hidden forms without saving
security settings. Three synthetic credential references contain no secrets.

Shared sizing checks compare visible form/control boxes with parent client
content boxes (padding, border and scrollbar aware), report active form caps,
and check pane20/section24/field-pair12/action8 spacing, equal outer insets
16/12/8 at desktop/tablet/phone widths, and 16px border-owning separator
insets (narrow normalized scroll gutters retain their distinct policy). Named quantity controls
use min(field width,220px); compound unit/buttons/avatar/navigation retain their
semantic roles. Curator range must fill the whole form in both source modes.
Imperative extension internals remain extension-owned; host slots still fill.
Native reachability checks include computed ancestor visibility and client-box
clipping. Every comparison checkpoint captures failures, restores the fixture,
and continues; accumulated failures still fail CI.

Root visibility uses the viewport client rectangle, not the scrolled HTML
DOMRect plus clientHeight (which would subtract page scroll twice). Nested
scrollports still use their inner client boxes. `client-clip.test.js` covers
both cases; reachability receipts include ancestor tags, root flags, DOMRects,
client dimensions and scroll offsets for diagnosis.
Baseline comparison selection resets document scroll natively; deliberate
last-item/action screenshots keep their scrolled positions. Explicit
`.settings-action` buttons are checked against their label plus padding/border,
not an arbitrary pixel cap. A synthetic repository preview exposes Install for
one conditional capture, then discards the draft without installing anything.

Single-section half-width contract: at the shared 640px available-workspace
breakpoint, a single form occupies the first equal grid track and leaves the
second empty. Below it the whole form uses the available width. The same test
applies to declarative form/activity extensions; paired and inventory layouts
retain their existing tests. All six normal built-in single-section variants
are checked at 1910px and 2560px with Statistics off/on; conditional single Rail
and empty-agent mounts are protected by component tests. Smaller viewport
checks retain Retention and authentication coverage.
Retention also has three near-breakpoint action captures: 700/768px with
Statistics closed and 1280px with Statistics open. Its final action must be
reachable through native scrolling and its action row must not clip or overflow.

Browser origin is absent from Connections navigation and has no fixture API
response; tests require zero reads to its removed settings endpoint. Backend
origin protection is outside this UI-only change. Trace retention replaces the
old simple-origin responsive representative rather than dropping width coverage.
Models capability checks require the four visible group titles below their
continuous top separators, not interrupting fieldset borders. Context/Input/
Output retain accessible group names via aria-labelledby; Output token limit
retains its associated input label. All existing Models density captures and
manual capability/save/reopen checks remain active.

## Current upstream reference-photo coverage

Personalization keeps the current OperatorProfile reference-photo component.
The fixture supplies a 64×64 synthetic PNG through the operator-owned metadata
and content endpoints, separate from avatars and agent photos. Chrome verifies
real image decoding, a synthetic upload acknowledgement, and filename/preview
persistence after navigating away and back. The component fixture also tests
removal acknowledgement. Existing five Personalization viewport/statistics
combinations check preview, filename and Paste reachability. No production
identity, attachment or backend is contacted.

Visual checklist: inspect `operator-reference-personalization-1600.png`, both
1910px Personalization statistics states, and the 390px statistics-open
Personalization capture. Verify the preview and file controls fit the profile
half without changing the appearance half or the Statistics dock.

## Failed Connect recovery

One-shot synthetic Save/Connect failures and an explicitly held retry verify
that only a failed Connect opens saved-provider connection fields. Visibility,
aria-expanded, recovery lock, unchanged draft/model selection, repeated-click
deduplication and clearing on success/provider switch/Cancel are checked.
Generic upstream failures deliberately avoid authentication wording. Captures
`models-connection-recovery-1910-statistics.png` and
`models-connection-recovery-390-statistics.png` show the editable key field
after native scrolling. All credentials and responses are synthetic.

### Browser startup diagnostics

The CI-only browser runner sends one `Browser.getVersion` readiness handshake
before creating its first target. Startup has a bounded 60-second deadline;
all subsequent CDP commands retain their 15-second deadline. There are no launch
retries or skipped UI assertions. `browser-startup.json` records the requested
binary, spawn arguments, PID, returned protocol/product version (when available),
process/pipe lifecycle and final pipe status, plus the last 64 KiB each of stdout
and stderr. A failed handshake is a failed run, not acceptance evidence. The
transport tests use fake event emitters and timers, not a local browser.
