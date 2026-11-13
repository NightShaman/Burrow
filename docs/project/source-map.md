# Source and coverage

The operator guide follows inspected current development implementation, without waiting for the daily public-source mirror. The Sunday reconciliation on **8 November 2026** compared every Burrow and Skills page with source for its setup, configuration, API, operations, troubleshooting, and historical scope. This is static documentation reconciliation, not a runtime acceptance test.

## Current implementation baseline

| Component | Inspected revision |
|---|---|
| Assembled Burrow, build `2026.11.12.3` | `e2f6c49c9d449bced1d18244b2551e9fee9a7755` |
| Core / Backend | `f589673df9124a459617f76230e90d021577a067` |
| UI | `f86bf45bf239606da23e6cf8bc370495e81eda88` |
| Skills | `31470b9f184efbe88dd8ae420d5286a7fd8303c5` |

The assembly's `SOURCE_VERSIONS` matches those Backend/UI pins. Private source links are intentionally not published. Older public commit links below remain historical evidence and are not silently repointed to claim current compatibility. Check your installed health/build identity before using a newer capability.

## Historical public baseline

- Repository: [GoblinKing-Burrow/Burrow](https://github.com/GoblinKing-Burrow/Burrow)
- Inspected public commit: [`deec39818955db1711161b5310d5822e65fda39a`](https://github.com/GoblinKing-Burrow/Burrow/tree/deec39818955db1711161b5310d5822e65fda39a)
- Release date/version: `2026.10.19`
- Frozen Burrow source: `6b0284c605dc6ed8ba0dae03ee5bbf9194bad981`
- Backend: `77f6da160ecae849aa83fc67d08ef4cc903d0b46`
- UI: `eee912f1e55308c79695bc7a304224cc6a501eab`
- Node Goblin: `42422cc42df619e47fec36e98293e5e4e51a7802`
- Goblin Secret Store: `15eeea33e4d179c2571a976e5ec9cbfbd9a1673a`
- Burrow Skills: `6860ba70b483e4bbd6ee3b7e5ea967dda6dfc211`
- Burrow Backdoor: `8e9a1d9b1bd5950c3a1882883ea2fde78f035f16`

These source pins are recorded in the public [PUBLIC_RELEASE.json](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/PUBLIC_RELEASE.json). A component pin records provenance; it does not mean that component is installed, enabled, or tested in your environment.

## Reconciliation on 21 October 2026

The original user-guide baseline was `deec398` (public 2026.10.19). The public revision inspected for the earlier review was [`aa5a30d`](https://github.com/GoblinKing-Burrow/Burrow/tree/aa5a30da683a3a8ea919025f107ff53f182ef8d6). At that earlier review, its executable `backend/`, `ui/` and installer content matched that release baseline; the later public commits then inspected changed documentation and presentation. This is not a claim about today’s public HEAD.

Newer implementation and source documentation were also compared through the current assembled build, including Dream-generated Brains, Global profiles, managed skills, compression, lifecycle recovery, the mod contract and update-channel handling. These behaviors are identified as newer/unpromoted in [release status](release-status.md); the current guide does not imply they shipped in 2026.10.19.

The older technical pages have mixed historical baselines, including early-October source and later corrections. Their source-review labels distinguish static reconciliation from end-to-end runtime validation. A page's publication date alone is not a runtime compatibility claim.

## What was refreshed

The eight **User guide** pages originated in that public snapshot and have now been reconciled with the current implementation: installation, first agent, everyday interface use, models, tools/mods, skills/memory, projects/tasks, and maintenance. Their retained source links point to immutable historical public code; the table above records current evidence. The homepage was refreshed during that earlier documentation work; this maintenance pass preserves the approved homepage and heroes.

The technical documentation is organized by **Concepts**, **Architecture**, **Operations**, **Security**, **Reference**, and **Development**, alongside the user guide. Pages reviewed against current source are not a separate historical manual. Historical source links, explicitly dated examples and screenshot qualifications retain their original scope; they do not establish current installed-version compatibility. Use the canonical installation and first-agent guides for setup. Older setup URLs remain as navigation pages so existing links continue to work.

The illustrated first-run guide now includes operator-supplied wizard screenshots supplied for the first-run guide. Those images illustrate the flow; they are not proof that every illustrated build is the public release. Existing earlier screenshots remain with the technical reference. They were captured from synthetic development fixtures on October 16, not from a tested public-release installation; they have not been relabeled as current screenshots. The homepage uses the repository's canonical `docs/assets/hero.png`, shared with its README; the header logo and favicon remain separate.

## Verification limits

Code inspection establishes what the release implements. It does not certify that every feature works with every provider or deployment. This refresh did not execute a live installation, model call, OAuth login, database restore, mod install, remote command, or production deployment. Documentation checks validate the site itself; they do not replace runtime testing.

Public release versions use `YYYY.MM.DD`, such as `2026.10.19`. Use the public release manifest and your installed version when reporting problems. Features present only in unmerged branches or plans are not documented as delivered. Current source implementation can precede the public sync and an operator's installed version.

## Documentation sources

The shared Docusaurus site lives in Docs-Website, with this project’s guides in `docs/burrow/`, navigation in `sidebars.json`, and settings in `docusaurus.config.js`. The original Burrow repository retains its separate MkDocs source and tooling. Keep behavior claims grounded in inspected current implementation and verify source citations when updating the guide.

See [Build this documentation](../development/documentation.md) for preview and validation commands.

## Ordinary update: 26 October 2026

Compared source changes since the full 25 October baseline. This pass reconciles native pool settings/catalogs/metrics, HTTP MCP headers and images, task/Forge archives, Dream promotion/reconciliation, A2A history and affected API/configuration instructions. It is not another full-page recertification or a live application/provider test. Skills implementation is unchanged; its newer repository revision contains the prior documentation update only. Approved site artwork is preserved independently of runtime-source documentation changes.

## Ordinary update: 27 October 2026

Compared changes since the 26 October source baseline: explicit busy-input queues and snapshot side questions, manual/pressure compaction feedback, per-agent Dream memory expression and no-save previews, GitHub workflow watches/receiver configuration, and Midnight appearance. OIDC setup/version guidance is maintained separately in [authentication](../security/authentication.md). Skills source is unchanged. This is bounded static delta reconciliation, not another full-page recertification or a live provider/database/webhook/login test. The Sunday full-review receipt remains dated 25 October; no runtime execution or public-release promotion is implied.

## Ordinary update: 28 October 2026

Compared implementation changes since the successful 27 October update. This pass reconciles Settings navigation and theme controls, provider/tool usage attribution, operational logs, targeted compaction and cooperative Stop handling, and bounded model-request recovery. Recovery resumes the failed model request with retained tool results; it does not replay completed tools. The seven separately documented components have no new source changes. The dated Sunday full review and previous delta evidence remain historical; this is not a new full audit, application test run, live installation check, or runtime release promotion.

## Ordinary update: 29 October 2026

Compared implementation changes since the successful 28 October update: native peer discovery and direct A2A guidance, configurable minion depth and descendant visibility, multiple telemetry destinations, bounded generic-provider recovery, and group transcript ownership. Node Goblin telemetry, Skills guidance and Goblin Secret Store access choices are reconciled separately. This is static changed-source review and basic documentation drift checking, not a new full review, application test run, live integration check or runtime release promotion.

## Ordinary update: 30 October 2026

Compared implementation changes since the successful 29 October baseline: independent Settings autosave with explicit coupled-form boundaries; Dream phase and workflow delivery history in Archive; agent-wide Minion discovery and source-authored delegation labels; full home-Core administrative API dispatch through a separately granted system capability; expanded operational/provider responsiveness telemetry; and preference adjudication against the current operator baseline. This is static changed-source reconciliation, not a full-page recertification, provider/application test, runtime deployment or release promotion. Historical screenshots and source qualifications remain intact.

## Ordinary update: 31 October 2026

Compared changes since the successful 30 October baseline: retained Chat occurrence-day discovery, local-day transcript filtering and readable reset origins; bounded SQL transcript pages and revision-bound cursors; request-owned Archive cancellation/timeouts and separate calendar/foreground reader lanes; mod-submitted image attachments; OAuth refresh persistence and selected-token identity across caller cancellation; and schema migrations 80–83. Managed-skill ownership/version guidance and Switchboard Telegram image support are reconciled in their component guides. This is static delta reconciliation, not a full-page recertification, application/provider test, runtime deployment or release promotion. Unchanged historical source links and screenshot qualifications remain intact.

## Sunday full reconciliation: 1 November 2026

Existing guides were compared with the current implementation across setup, configuration, routing, APIs, operations, troubleshooting and skills. Corrections include saved board-task scheduling and one-time consumption, independent Anthropic thinking modes and paginated native catalogues, current Settings/task-board behavior, and migration inventory through 85. Historical screenshots and immutable public-source receipts remain explicitly historical. This is static documentation reconciliation, not a runtime installation, provider call, application test run or release promotion.

## Navigation cleanup: 1 November 2026

The misleading earlier-reference navigation group was removed after the Sunday reconciliation. Useful technical pages retain their URLs and source-review qualifications; overlapping setup instructions are consolidated into the user guide, with old setup URLs and section anchors retained as links to the canonical instructions. The illustrated screen reference remains available for detailed UI guidance. This is an editorial and navigation change, not another implementation audit, runtime test or release promotion.

## 2 November ordinary delta review

The current table pins build 2026.11.02.4 and its matching Backend/UI sources. This pass covers canonical agent/operator/Mod photos, Forge reference selection, per-peer A2A inboxes, structured chat terminal failures, explicit API-model opt-in, retention form reads, deployment-only Origin controls and migrations 86–89. Unchanged pages inherit the dated 1 November full review; historical screenshots and pinned public-source links remain historical. No application tests, provider calls or installed-instance upgrades are claimed.

## 3 November implementation delta

Current inspected assembly **2026.11.03.8**, commit `400ec8f2d0b24478ca2185bf8c38aee2ede4c445`, records Core `32dde3266a231777ddfec6dba141d6b9972a21fd` and UI `4a17a8c73c588a7582835ca6ff50dcabe409c33c`. This ordinary pass follows the merged Settings layout contract, horizontal agent-button overflow, latest-request context measurement and correlated provider usage, generic mod-owned native agent isolation, and preserved executable permissions in the release artifact handoff. The application schema reaches migration 90 for mod-owned agent metadata. The separately documented mod and skill repositories have no newer source commits than the previous documentation baseline; their cross-component compatibility is still checked.

The full review remains dated **1 November**. This is static source reconciliation and safe documentation validation, not application/provider testing, a runtime deployment or proof that public releases and installed versions already include these changes.

## 4 November implementation delta

Inspected assembly **2026.11.04.9**, commit `86f41581cf4feccbd2126db38a6b746db6483080`, records Core `b62c57ef5e831bacebf2214a31c04147471c1267` and UI `f952d9494f97326f3f656c5a5427e9d4efc20e3a`. This ordinary pass reconciles independent mod-management/Core API agent authority, reset operation receipts and read-only outcome recovery, automatic A2A final delivery and transcript attribution, empty initial peer-directory cursors, canonical owned-agent avatars, imperative Settings layout/selector/navigation contracts and opt-in Archive heading/date/timezone support. The application schema reaches migration 92.

The full review remains dated **1 November 2026**. This is changed-source/static documentation reconciliation, not application/provider testing, runtime deployment, public release promotion or proof of your installed behavior. Earlier dated sections and public-source links are historical evidence; current component and skill receipts are maintained separately. Menagerie remains a homepage placeholder, without a new full documentation section.

## 5 November implementation delta

Inspected assembly **2026.11.05.4**, commit `1952f88ff182ef465370209f3f1969cbdfbd79e6`, records Core `6465a9b200bc550697ddfc41959d671eac9abf33` and UI `4f7f58f682a0cffe83290276307c66631a361de3`. This ordinary pass reconciles current-intent preference curation, indexed session recall and optional conversation embeddings, OpenAI-compatible embedding support, enabled-mod shared guidance, resident model-connection identity and retained Chat errors, and catalog-refresh controls. Switchboard's native Settings workspaces and historical Archive are reconciled in its component guide.

The full page review remains dated **1 November**; unchanged pages retain that evidence. These are static source and test-file checks, not executed application/provider tests, a runtime deployment or a release promotion. Public mirrors and installed packages can lag development source. Menagerie's coming-soon placeholder and approved artwork/navigation remain unchanged.

## Ordinary source delta: 6 November 2026

Compared the 5 November baseline with assembly `e8acb74a168970eb5dbfdd463745144976811b19` (**2026.11.06.8**), Core `4e5a505c12b236ed394b09a577a2d583b409a69f` and UI `aa759fbf429cebd5fe070d3eb28491f63bf5fc77`. Source areas inspected include `context-report.mjs`, `provider-turn-replay.mjs`, provider pool/recovery and error projection, active-session display/archive paging, recall backfill, Forge store/tools, Chat transcript/navigation/cache/input ownership and regression test definitions. Affected guides describe current implementation; unchanged sections keep their prior full-review evidence.

No runtime tests, live provider calls, migrations or installed-package checks were performed. Public links remain historical immutable references; source hashes record the inspected development revisions without exposing private source URLs.

## 7 November ordinary delta review

Inspected assembly **2026.11.07.5**, commit `c057b5e4369c9c2758c8a8ead784d59ff2e1a5db`, records Core `f0b17efdadc57c856eb3c5cf5272a3fff2268ad1` and UI `9e53442cdb1c8bbb882195d9f3de10419938a6b2`. This pass reconciles enforced A2A default-session preferences, interrupted child admission, active continuation recaps, opt-in expiring OAuth resets and durable outcomes, mod completion/activity metadata, scheduler recovery, UI ownership/refresh warnings and application migrations 97–99. Managed-skill failure no longer undoes a completed mod disable/uninstall.

Unchanged sections inherit the **1 November** full review. Source and test definitions were inspected statically; no application tests, provider calls, database migrations, runtime changes or release promotions were performed. Public mirrors and installed versions may lag these source pins. Menagerie now has a separately maintained public-release guide; older dated placeholder statements describe their original review date only.

## Sunday full reconciliation: 8 November 2026

The full Core guide set was compared with assembly **2026.11.08.4** (`1f77c9d0277585bfe1963ce3ab3d2cdf35f16b9a`), Core `6b682eae6cd0dc6efa79e173b7d819fb219443b3` and UI `d337e5a61667335cfaaff5b23b36c052ac6e71bb`. Review covered setup, configuration, routing, API contracts, operations, troubleshooting and cross-guide consistency. Corrections include Parked tasks and dispatch eligibility, enforced default A2A routing, reusable Forge image references, depth-aware Minion cleanup, current schema/API inventory and recovery/export boundaries.

This is static implementation reconciliation and documentation validation, not executed application/provider testing, a live installation or restore, a release promotion, or proof that an installed/public build already has the behavior. Earlier dated review sections and public-source links remain historical. Approved illustrations, layout and card order are preserved.

### Publication-time source check

Before publication, the additional changes in assembly **2026.11.08.7** (`79c4346acf461ddbb16fe94d85d1a387df3ddc80`), Core `f7ab762d49b9e65ea3e071ba762dfcea16e0e01a` and UI `e51eaf1e1ebb65c9eee60690643746619a4a549b` were inspected. They tighten malformed native-tool argument rejection, provider streaming completion/cancellation and stale Chat paging after reset. The full review above remains the base; this final static delta preserves concurrent runtime changes and adds no application/provider test claim.

## 9 November ordinary delta review

Compared the successful 8 November source baseline through assembly **2026.11.08.19** (`20523845840bb4763e0fe137d603a7f54d8c5a9d`), Core `a799735c9b0d7fbdeb49dcebfc7acb798356d476` and UI `a7c081019a91f91c038ec2ed65b9b1ab3a50f666`. This pass reconciles operator-wide workspace preference persistence/retry, confirmed group-room deletion and retained participant history, mod-owned initial-session repair, Anthropic schema/image conversion and provider-pool continuation headroom/replay, plus code-block copying behavior.

Unchanged pages retain the **8 November** full-review evidence. Source and test definitions were inspected statically; no application tests, live model/chat calls, migrations, runtime changes or release promotion were performed. Installed/public builds may lag development implementation. Historical screenshots and private-source-link exclusions are preserved.


## 10 November ordinary delta review

Inspected assembly **2026.11.10.3**, commit `1a59d735bd3142969830431e55183fd8a5130ae4`, records Core `60427dd6c41e129d6597ee2f4e9bc08eca13f4e1` and UI `7656f04568008b6a94b40c1c8b35cc479db39a22`. The ordinary pass reconciles explicit hidden-identity discovery for mods, provider-filtered Forge selection, saved A2A sender avatars and scoped mod-panel query forwarding. Models metadata remains read-only; navigation spacing, theme styling and the application favicon do not change the documentation site's approved artwork or navigation.

The full page review remains dated **8 November**. Source and test definitions were inspected statically; this is not an application/browser test run, provider call, runtime deployment or release promotion. Unchanged sections retain their prior evidence. Public mirrors and installed builds may lag current development source.

## Ordinary update: 11 November 2026

The UI now opens links in operator and agent chat messages in a new tab, including group chat, without navigating away from the conversation. Named links, bare web addresses and relative links share this behavior; code remains code. Backend, mod implementations and all eight reviewed skill payloads are unchanged from the previous pass. The Skills implementation pin above remains valid; its later documentation-only commit is recorded in the maintenance receipts.

Source inspection covered `ChatMessage.tsx`, its regression cases and the assembly source manifest. No application tests, external chat calls or skill scripts ran during this documentation pass.

## 12 November ordinary delta review

Checked **12 November 2026**: Assembly **2026.11.12.2** and the current table pins reconcile the delta since the successful 11 November baseline. Inspected changes cover typed GIF/native Google video and references, turn-owned artifact delivery, mod tool attribution, complete accepted chat inputs, mention/command parsing, persistent authored drafts, server-anchored account freshness, filesystem/search/patch evidence, scheduler pagination, MCP discovery, Responses aggregation and bounded rule evaluation. Tutor cross-contract notes distinguish newer Core capabilities from unchanged lab routes.

The full review remains **8 November**. Source and regression-test definitions were inspected statically; no application/provider tests, external chat calls, runtime changes or release promotion were performed. Unchanged historical evidence remains dated. These are implementation pins, not the later documentation-only commit IDs, which belong in maintenance receipts. Installed builds and public mirrors may lag this source.

## 13 November ordinary delta review

The current table records assembly **2026.11.12.3** and its exact Backend/UI pins. Compared with the 12 November implementation baseline, runtime changes are confined to chat render reuse and terminal-summary reconciliation in the UI. Review covered `ChatMessage.tsx`, `chatValueEquality.ts`, `chatActivityProjection.ts`, `useChatInputs.ts`, `useChatRecovery.ts`, `useChatSession.ts`, their regression-test definitions, and the assembly manifest. The separate Backend head `58e2c3c0be3cd5556d18bcacb225e8df66c2f513` adds the previous documentation/skill correction only; it does not introduce another runtime change.

See [the interface behavior](../concepts/interface.md#chat-polling-and-render-reuse). This is a static ordinary delta, not another full review, performance benchmark or application/provider test. Earlier dated review sections retain their own pins; unchanged pages inherit the **8 November** full reconciliation and subsequent reviewed deltas.

