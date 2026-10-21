# Which behavior does my version have?

Checked **21 October 2026**. The latest public Core source inspected is still **2026.10.19**, at commit [`aa5a30d`](https://github.com/GoblinKing-Burrow/Burrow/tree/aa5a30da683a3a8ea919025f107ff53f182ef8d6). Its executable code matches the guide's original [`deec398`](https://github.com/GoblinKing-Burrow/Burrow/tree/deec39818955db1711161b5310d5822e65fda39a) release baseline; intervening public commits changed documentation.

Later Core implementation was also reviewed. The changes below are **implemented in the newer source but not present in that public Core snapshot**. A date on this website, a mod update, or a successful documentation deployment does not update your running Core. Check `/api/health`, the installed `SOURCE_VERSIONS`, and the public release manifest before following newer-only instructions.

| Area | Public Core 2026.10.19 | Newer implementation reviewed on 21 October |
|---|---|---|
| Dreaming | Writes compact DreamMemory and scoped preload records; separate from Brains | Saves individual Dream-generated connections in Brains; neither DreamMemory nor Dream preloads enter ordinary turn context |
| Shared profile guidance | Agent-local profile documents | Global Rules and Global Orientation, independently enabled per agent and placed before that agent's local document |
| Managed operating skills | Automatic adoption of the official runtime skill through its Git source | Dedicated read-only managed skills for Core and loaded mods, automatically synchronized and available across agents |
| Mod access settings | Operator login is required even with authentication disabled | Direct UI access works with `authMode: none`; authenticated mode still requires operator login; API tokens do not authorize this route |
| Conversation compression | Older rendered-recap merge | Rebuilds covered items from available original entries, deduplicates source identities and keeps whole items inside one handoff wrapper |
| Stop, reset and restart | Earlier lifecycle behavior | Cancellation deadline handling, reset-generation fencing and bounded recovery protect subsequent work from stale runs |
| Native update channel | Public updater selects the public repository | Installer/launcher preserve a configured update repository across updates |

## What to do now

- If you run the public release, use the version-pinned [user guides](../guide/installation.md).
- If your installed build includes the newer behavior, use the clearly marked newer sections in [Skills and memory](../guide/skills-and-memory.md), [Dream cycles](../concepts/dreams.md), and [Conversation history](../concepts/conversation-history.md).
- If a setting is missing, check Core's version before reinstalling a mod or changing authentication.
- For remote execution, use [Node Goblin](https://burrow-docs.blissful-psychosis.com/node-goblin/) with [Backdoor](https://burrow-docs.blissful-psychosis.com/burrow-backdoor/) to retain an internal path to the agent's home Burrow.

Public calendar tags are created by coordinated promotion. This review did not create a release or advance a tag. Future release dates are not promised here.
