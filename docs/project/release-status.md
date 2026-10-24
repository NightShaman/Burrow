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

## Current implementation check: 24 October 2026

This nightly pass uses current development implementation as documentation truth; it does not wait for a public mirror or alter a release. Pins:

- Assembled Burrow: `3fd3a55ef3aefa0ad3d24d71c6434510b869653a`.
- Core: `e7cc546706f42bb4d5fdd10b3d8d8099b9ad5699`.
- UI: `5f7b320a8a0993ba25f187b4fb72d06b70188265`.
- Operating skills: `3a4e8dd1a63428cf2b535108a488c3bd41612d15`.

Recent operator-facing changes include a **Browse stored credentials** picker and configured-credential state for HTTPS mod sources, plus a per-agent **A2A in default** routing toggle and readable external-chat session labels. See [tools and mods](../guide/tools-and-mods.md#private-source-credentials-in-current-core) and [everyday use](../guide/everyday-use.md#current-session-routing-controls).

The dedicated Core/mod-managed skill catalog is implemented, not merely planned. Its startup/lifecycle/periodic reconciliation and read-only ownership are described in [managed skills](https://burrow-docs.blissful-psychosis.com/burrow-skills/managed-skills/). Older installed builds may still use the historical adoption mechanism above.

Current Core also exposes mod-owned external-turn cancellation and session create/model controls. Cancellation is cooperative and must be polled to terminal status; new-session creation does not delete an old conversation or cancel its work. These are Core capabilities, not proof that every transport mod exposes matching commands. Follow each mod's documentation and installed-version requirements.

This was a source-grounded documentation check, not a live provider or full application test. Older reference pages remain explicitly historical; this ordinary pass does not recertify every earlier source link.

## What to do now

- If you run the public release, use the version-pinned [user guides](../guide/installation.md).
- If your installed build includes the newer behavior, use the clearly marked newer sections in [Skills and memory](../guide/skills-and-memory.md), [Dream cycles](../concepts/dreams.md), and [Conversation history](../concepts/conversation-history.md).
- If a setting is missing, check Core's version before reinstalling a mod or changing authentication.
- For remote execution, use [Node Goblin](https://burrow-docs.blissful-psychosis.com/node-goblin/) with [Backdoor](https://burrow-docs.blissful-psychosis.com/burrow-backdoor/) to retain an internal path to the agent's home Burrow.

Public calendar tags are created by coordinated promotion. This review did not create a release or advance a tag. Future release dates are not promised here.

