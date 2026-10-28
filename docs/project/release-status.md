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

Reviewed on **22 October 2026**: ordinary mods can request asynchronous, potentially paid image jobs through Core’s saved Forge selection and read only their own image jobs. The [Tutor Forge lesson](https://burrow-docs.blissful-psychosis.com/burrow-tutor/forge-images/) covers consent, durable retries, and previews. This interface is absent from the older public snapshot above. Current guides follow implementation; the public snapshot follows the daily sync. Update Core alongside mods that use this capability.

## Current implementation check: 28 October 2026

This nightly pass uses current development implementation as documentation truth; it does not wait for a public mirror or alter a release. Pins:

- Assembled Burrow: `e1cee57c7851337bf91d179208e6cbfbd47dbdf6`.
- Core: `a04acb16b0eab2a910c3ef0fb452622df81a05cb`.
- UI: `b6217d4d7613dadffb444910d4715b12ed17630c`.
- Operating skills: `2d120d42020eb13bc4ff0b613ea8badc46bdef1b`.

Recent operator-facing changes include a **Browse stored credentials** picker and configured-credential state for HTTPS mod sources, plus a per-agent **A2A in default** routing toggle and readable external-chat session labels. See [tools and mods](../guide/tools-and-mods.md#private-source-credentials-in-current-core) and [everyday use](../guide/everyday-use.md#current-session-routing-controls).

The dedicated Core/mod-managed skill catalog is implemented, not merely planned. Its startup/lifecycle/periodic reconciliation and read-only ownership are described in [managed skills](https://burrow-docs.blissful-psychosis.com/burrow-skills/managed-skills/). Older installed builds may still use the historical adoption mechanism above.

Current Core also exposes mod-owned external-turn cancellation and session create/model controls. Cancellation is cooperative and must be polled to terminal status; new-session creation does not delete an old conversation or cancel its work. These are Core capabilities, not proof that every transport mod exposes matching commands. Follow each mod's documentation and installed-version requirements.

The reviewed assembly identifies itself as **2026.10.28.8**. Native **OpenAI LB** and **Anthropic LB** connection types are now present in default-branch UI and Core, with same-family OAuth membership and bounded text-model routing. See [account-pool setup and limitations](../guide/models.md#native-oauth-account-pools). This is implemented source, not a claim of successful live provider validation. Current schema inventory reaches migration **77**. `run_evidence_search` adds explicit agent-owned historical proof retrieval; it does not add automatic prompt recall or a new HTTP API.

The earlier Sunday pass reconciled the full documentation surface, including historical-page scope. No live provider, OAuth, installation, database restore, runtime test, or unmerged branch was treated as successful verification. Historical examples remain historical; documentation publication does not establish runtime readiness.

## What to do now

- Start with the [current operator guide](../guide/installation.md) and compare its source coverage with your installed build.
- If your installed build includes the newer behavior, use the clearly marked newer sections in [Skills and memory](../guide/skills-and-memory.md), [Dream cycles](../concepts/dreams.md), and [Conversation history](../concepts/conversation-history.md).
- If a setting is missing, check Core's version before reinstalling a mod or changing authentication.
- For remote execution, use [Node Goblin](https://burrow-docs.blissful-psychosis.com/node-goblin/) with [Backdoor](https://burrow-docs.blissful-psychosis.com/burrow-backdoor/) to retain an internal path to the agent's home Burrow.

Public calendar tags are created by coordinated promotion. This review did not create a release or advance a tag. Future release dates are not promised here.

## Ordinary update: 26 October 2026

Compared source changes since the full 25 October baseline. This pass reconciles native pool settings/catalogs/metrics, HTTP MCP headers and images, task/Forge archives, Dream promotion/reconciliation, A2A history and affected API/configuration instructions. It is not another full-page recertification or a live application/provider test. Skills implementation is unchanged; its newer repository revision contains the prior documentation update only. Approved site artwork is preserved independently of runtime-source documentation changes.

## Ordinary update: 27 October 2026

Compared changes since the 26 October source baseline: explicit busy-input queues and snapshot side questions, manual/pressure compaction feedback, per-agent Dream memory expression and no-save previews, GitHub workflow watches/receiver configuration, and Midnight appearance. OIDC setup/version guidance is maintained separately in [authentication](../security/authentication.md). Skills source is unchanged. This is bounded static delta reconciliation, not another full-page recertification or a live provider/database/webhook/login test. The Sunday full-review receipt remains dated 25 October; no runtime execution or public-release promotion is implied.

## Ordinary update: 28 October 2026

Compared implementation changes since the successful 27 October update. This pass reconciles Settings navigation and theme controls, provider/tool usage attribution, operational logs, targeted compaction and cooperative Stop handling, and bounded model-request recovery. Recovery resumes the failed model request with retained tool results; it does not replay completed tools. The seven separately documented components have no new source changes. The dated Sunday full review and previous delta evidence remain historical; this is not a new full audit, application test run, live installation check, or runtime release promotion.
