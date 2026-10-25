# Source and coverage

The operator guide follows inspected current development implementation, without waiting for the daily public-source mirror. The Sunday reconciliation on **25 October 2026** compared every Burrow and Skills page with source for its setup, configuration, API, operations, troubleshooting, and historical scope. This is static documentation reconciliation, not a runtime acceptance test.

## Current implementation baseline

| Component | Inspected revision |
|---|---|
| Assembled Burrow, build `2026.10.25.9` | `f9d1bc5b1b04e3d7f29c6b4f62e0feb935bff487` |
| Core / Backend | `3bf50374d3601c821e787912d52b9044eaf649ec` |
| UI | `0610bac85b2e636b79bbdf09fc3a95c3a519fa5a` |
| Skills | `b81616ef9c8168d7fe9dcc8bd8e244149401fcc7` |

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

The older technical pages have mixed historical baselines, including early-October source and later corrections. Their warning labels remain where a full end-to-end revalidation has not been performed. A page's publication date alone is not a runtime compatibility claim.

## What was refreshed

The eight **User guide** pages originated in that public snapshot and have now been reconciled with the current implementation: installation, first agent, everyday interface use, models, tools/mods, skills/memory, projects/tasks, and maintenance. Their retained source links point to immutable historical public code; the table above records current evidence. The homepage was refreshed during that earlier documentation work; this maintenance pass preserves the approved homepage and heroes.

The **Earlier technical reference** is preserved for historical context and existing links. Historical warning labels and pinned examples remain where appropriate. This full documentation pass checks those boundaries rather than relabeling every older example as current. Historical descriptions may differ from today's public behavior. Do not use old image tags, install commands, or security assumptions as current instructions.

The illustrated first-run guide now includes operator-supplied wizard screenshots supplied for the first-run guide. Those images illustrate the flow; they are not proof that every illustrated build is the public release. Existing earlier screenshots remain with the technical reference. They were captured from synthetic development fixtures on October 16, not from a tested public-release installation; they have not been relabeled as current screenshots. The homepage uses the repository's canonical `docs/assets/hero.png`, shared with its README; the header logo and favicon remain separate.

## Verification limits

Code inspection establishes what the release implements. It does not certify that every feature works with every provider or deployment. This refresh did not execute a live installation, model call, OAuth login, database restore, mod install, remote command, or production deployment. Documentation checks validate the site itself; they do not replace runtime testing.

Public release versions use `YYYY.MM.DD`, such as `2026.10.19`. Use the public release manifest and your installed version when reporting problems. Features present only in unmerged branches or plans are not documented as delivered. Current source implementation can precede the public sync and an operator's installed version.

## Documentation sources

The shared Docusaurus site lives in Docs-Website, with this project’s guides in `docs/burrow/`, navigation in `sidebars.json`, and settings in `docusaurus.config.js`. The original Burrow repository retains its separate MkDocs source and tooling. Keep behavior claims grounded in inspected current implementation and verify source citations when updating the guide.

See [Build this documentation](../development/documentation.md) for preview and validation commands.
