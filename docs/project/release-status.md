# Which behavior does my version have?

Historical public baseline checked **21 October 2026**: the Core source inspected was **2026.10.19**, at commit [`aa5a30d`](https://github.com/GoblinKing-Burrow/Burrow/tree/aa5a30da683a3a8ea919025f107ff53f182ef8d6). Its executable code matches the guide's original [`deec398`](https://github.com/GoblinKing-Burrow/Burrow/tree/deec39818955db1711161b5310d5822e65fda39a) release baseline; intervening public commits changed documentation.

Later Core implementation was also reviewed. This historical comparison is not a claim that 2026.10.19 remains the latest available public release. The changes below are **implemented in the newer source but not present in that public Core snapshot**. A date on this website, a mod update, or a successful documentation deployment does not update your running Core. Check `/api/health`, the installed `SOURCE_VERSIONS`, and the public release manifest before following newer-only instructions.

| Area | Public Core 2026.10.19 | Newer implementation reviewed on 21 October |
|---|---|---|
| Dreaming | Writes compact DreamMemory and scoped preload records; separate from Brains | Saves individual Dream-generated connections in Brains; neither DreamMemory nor Dream preloads enter ordinary turn context |
| Shared profile guidance | Agent-local profile documents | Global Rules and Global Orientation, independently enabled per agent and placed before that agent's local document |
| Managed operating skills | Automatic adoption of the official runtime skill through its Git source | Dedicated read-only managed skills for Core and loaded mods, automatically synchronized and available across agents |
| Mod access settings | Operator login is required even with authentication disabled | Direct UI access works with `authMode: none`; authenticated mode still requires operator login; API tokens do not authorize this route |
| Conversation compression | Older rendered-recap merge | Rebuilds covered items from available original entries, deduplicates source identities and keeps whole items inside one handoff wrapper |
| Stop, reset and restart | Earlier lifecycle behavior | Cancellation deadline handling, reset-generation fencing and bounded recovery protect subsequent work from stale runs |
| Native update channel | Public updater selects the public repository | Installer/launcher preserve a configured update repository across updates |

## Forge image capability

Reviewed on **22 October 2026**: ordinary mods can request asynchronous, potentially paid image jobs through Core’s saved Forge selection and read only their own image jobs. The [Tutor Forge lesson](https://docs.goblin-kingdom.com/burrow-tutor/forge-images/) covers consent, durable retries, and previews. This interface is absent from the older public snapshot above. Current guides follow implementation; the public snapshot follows the daily sync. Update Core alongside mods that use this capability.

## Full implementation check: 1 November 2026

The 1 November full pass used its dated development implementation as documentation truth; it does not wait for a public mirror or alter a release. Pins:

- Assembled Burrow: `fe851c4e546c9bf9f53f861e24f918474432c296`.
- Core: `8b5889115680bcdbf698f1b93126254e1cf4d2e6`.
- UI: `e6d3fe7b17da1c68d380f1e28482fd9c5819cdef`.
- Operating skills: `1f464f48b651a78c3c90599ffee674a627cf67e3`.

Recent operator-facing changes include a **Browse stored credentials** picker and configured-credential state for HTTPS mod sources, plus a per-agent **A2A in default** routing toggle and readable external-chat session labels. See [tools and mods](../guide/tools-and-mods.md#private-source-credentials-in-current-core) and [everyday use](../guide/everyday-use.md#current-session-routing-controls).

The dedicated Core/mod-managed skill catalog is implemented, not merely planned. Its startup/lifecycle/periodic reconciliation and read-only ownership are described in [managed skills](https://docs.goblin-kingdom.com/burrow-skills/managed-skills/). Older installed builds may still use the historical adoption mechanism above.

Current Core also exposes mod-owned external-turn cancellation and session create/model controls. Cancellation is cooperative and must be polled to terminal status; new-session creation does not delete an old conversation or cancel its work. These are Core capabilities, not proof that every transport mod exposes matching commands. Follow each mod's documentation and installed-version requirements.

The reviewed assembly identifies itself as **2026.11.01.7**. Native **OpenAI LB** and **Anthropic LB** connection types are now present in default-branch UI and Core, with same-family OAuth membership and bounded text-model routing. See [account-pool setup and limitations](../guide/models.md#native-oauth-account-pools). This is implemented source, not a claim of successful live provider validation. Current schema inventory reaches migration **85**. `run_evidence_search` adds explicit agent-owned historical proof retrieval; it does not add automatic prompt recall or a new HTTP API.

The earlier Sunday pass reconciled the full documentation surface, including historical-page scope. No live provider, OAuth, installation, database restore, runtime test, or unmerged branch was treated as successful verification. Historical examples remain historical; documentation publication does not establish runtime readiness.

## What to do now

- Start with the [current operator guide](../guide/installation.md) and compare its source coverage with your installed build.
- If your installed build includes the newer behavior, use the clearly marked newer sections in [Skills and memory](../guide/skills-and-memory.md), [Dream cycles](../concepts/dreams.md), and [Conversation history](../concepts/conversation-history.md).
- If a setting is missing, check Core's version before reinstalling a mod or changing authentication.
- For remote execution, use [Node Goblin](https://docs.goblin-kingdom.com/node-goblin/) with [Backdoor](https://docs.goblin-kingdom.com/burrow-backdoor/) to retain an internal path to the agent's home Burrow.

Public calendar tags are created by coordinated promotion. This review did not create a release or advance a tag. Future release dates are not promised here.

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

## 2 November implementation delta

Current inspected assembly **2026.11.02.4**, commit `d25beccce60830cf4159d91cae9a97dec38eefd2`, records Backend `69f644aaf9f0060fac7003c22e77f7a3da7c0471` and UI `1c396911c2f47137f5ea0ba3759a960de31770c4`. It includes canonical agent/operator reference photos for supported Forge image models, separate per-peer A2A inboxes, structured terminal error persistence, explicit opt-in for newly discovered API models, cheaper retention policy reads, and environment-only Origin checking. The database ledger reaches 89. This ordinary delta supplements, rather than repeats, Sunday's full reconciliation. Public mirror and installed-version availability remain separate checks.

## 3 November implementation delta

Current inspected assembly **2026.11.03.8**, commit `400ec8f2d0b24478ca2185bf8c38aee2ede4c445`, records Core `32dde3266a231777ddfec6dba141d6b9972a21fd` and UI `4a17a8c73c588a7582835ca6ff50dcabe409c33c`. This ordinary pass follows the merged Settings layout contract, horizontal agent-button overflow, latest-request context measurement and correlated provider usage, generic mod-owned native agent isolation, and preserved executable permissions in the release artifact handoff. The application schema reaches migration 90 for mod-owned agent metadata. The separately documented mod and skill repositories have no newer source commits than the previous documentation baseline; their cross-component compatibility is still checked.

The full review remains dated **1 November**. This is static source reconciliation and safe documentation validation, not application/provider testing, a runtime deployment or proof that public releases and installed versions already include these changes.

## 4 November implementation delta

Inspected assembly **2026.11.04.9**, commit `86f41581cf4feccbd2126db38a6b746db6483080`, records Core `b62c57ef5e831bacebf2214a31c04147471c1267` and UI `f952d9494f97326f3f656c5a5427e9d4efc20e3a`. This ordinary pass reconciles independent mod-management/Core API agent authority, reset operation receipts and read-only outcome recovery, automatic A2A final delivery and transcript attribution, empty initial peer-directory cursors, canonical owned-agent avatars, imperative Settings layout/selector/navigation contracts and opt-in Archive heading/date/timezone support. The application schema reaches migration 92.

The full review remains dated **1 November 2026**. This is changed-source/static documentation reconciliation, not application/provider testing, runtime deployment, public release promotion or proof of your installed behavior. Earlier dated sections and public-source links are historical evidence; current component and skill receipts are maintained separately. Menagerie remains a homepage placeholder, without a new full documentation section.

## 5 November implementation delta

Inspected assembly **2026.11.05.4**, commit `1952f88ff182ef465370209f3f1969cbdfbd79e6`, records Core `6465a9b200bc550697ddfc41959d671eac9abf33` and UI `4f7f58f682a0cffe83290276307c66631a361de3`. This ordinary pass reconciles current-intent preference curation, indexed session recall and optional conversation embeddings, OpenAI-compatible embedding support, enabled-mod shared guidance, resident model-connection identity and retained Chat errors, and catalog-refresh controls. Switchboard's native Settings workspaces and historical Archive are reconciled in its component guide.

The full page review remains dated **1 November**; unchanged pages retain that evidence. These are static source and test-file checks, not executed application/provider tests, a runtime deployment or a release promotion. Public mirrors and installed packages can lag development source. Menagerie's coming-soon placeholder and approved artwork/navigation remain unchanged.

## 6 November implementation delta

Inspected assembly **2026.11.06.8**, commit `e8acb74a168970eb5dbfdd463745144976811b19`, records Core `4e5a505c12b236ed394b09a577a2d583b409a69f` and UI `aa759fbf429cebd5fe070d3eb28491f63bf5fc77`. This ordinary source delta reconciles retained compacted scrollback, captured context reports, provider explanation/copy fidelity, the inclusive five-hour pool headroom floor, bounded unavailable-pool waits, nonblocking recall rollout/migration 96, current chat navigation and native Forge wait/assistant delivery. The operator Forge HTTP surface remains asynchronous.

The full-page review remains dated **1 November**. This is static source and test-file inspection with documentation checks, not executed application/provider tests, runtime deployment, release promotion or verification of an installed build. Menagerie remains a coming-soon placeholder.

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
