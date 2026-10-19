# Source and coverage

The user guide documents the public **2026.10.19** release of Burrow. It is grounded in executable code from the public repository, not assumed parity with newer NightShaman development work.

## Public baseline

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

## What was refreshed

The eight **User guide** pages were written for this public snapshot: installation, first agent, everyday interface use, models, tools/mods, skills/memory, projects/tasks, and maintenance. Their source links point to immutable public code. The homepage and documentation build instructions were also refreshed.

The **Earlier technical reference** is preserved for historical context and existing links. Every retained page is marked as not fully revalidated for 2026.10.19. Older NightShaman links on those pages document their cited revisions, not necessarily today's public behavior. Do not use old image tags, install commands, or security assumptions as current instructions.

Existing screenshots remain with the earlier reference. They were captured from synthetic development fixtures on October 16, not from a tested public-release installation; they have not been relabeled as current screenshots. The new homepage uses the repository's existing Burrow logo.

## Verification limits

Code inspection establishes what the release implements. It does not certify that every feature works with every provider or deployment. This refresh did not execute a live installation, model call, OAuth login, database restore, mod install, remote command, or production deployment. Documentation checks validate the site itself; they do not replace runtime testing.

NightShaman development versions use `YYYY.MM.DD.#`; GoblinKing-Burrow public versions use `YYYY.MM.DD` without the numeric suffix. This formatting difference is expected and does not itself mean a release is stale. Compare the manifest and source revisions.

The public release and development builds have different publication boundaries. A feature seen in NightShaman after the frozen source revisions is not automatically included here. Use the public release manifest and installed version when reporting problems.

## Where documentation changes belong

The public tree is promoted from NightShaman/Burrow. The promotion copies `docs/`, `mkdocs.yml`, documentation dependency files, and `scripts/docs/`. Its publisher replaces the public repository contents, so editing only the public copy will not survive a later promotion.

Maintain this hand-written documentation in the upstream Burrow documentation paths, while keeping its product claims pinned to an inspected public release. Do not put documentation edits into generated application directories or change the root README as part of this site refresh. The documentation workflow is preserved separately in public promotion and deploys only from GoblinKing-Burrow/Burrow; development and release workflows are not copied. Hosting and custom-domain configuration remain separate from the documentation build.

See [Build this documentation](../development/documentation.md) for preview and validation commands.
