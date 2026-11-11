# Mod tool identity acceptance fixture

Open `http://10.10.20.105:5174/scripts/mod-tool-identity-fixture/index.html` on the existing development server. This fixture renders actual ChatTranscript components and projectChatActivity using synthetic progress events matching the Core `mod_agent_tool` + `modToolName` contract. It does not execute tools, change settings, or make API writes. It is component-level evidence, not proof of deployed backend delivery.

## Acceptance brief (verbatim, chronology)

Original operator: `Why do I only see mod_agent_tool and not the actual tool name?`

Then: `so lets fix it`

Hatchet delegation: `Boss requests fix actual tool name in activity instead of mod_agent_tool. Prior inspected: Core execution identity modToolName, UI chatToolIdentity handles mcp_call not mod_agent_tool. Please own UI fix in /mnt/local/projects/Burrow-HC/Burrow-UI: inspect actual schema, minimal shared identity fix across live/completed activity; regression tests and comparable actual before/after visual evidence if available, preserve layout. Backend investigation mine; coordinate metadata needs. Existing untracked group-delete-review.html/scripts/group-delete-review.tsx unrelated—leave alone. Need fresh GPT-6-Luna acceptance before commit/push. No deploy/restart. Original operator: 'Why do I only see mod_agent_tool and not the actual tool name?' then 'so lets fix it'. Report contract needs, implement and test through completion; hold push for coordination.`

## Candidate and evidence

Base: `e341d9c645289d97cb655a02a950fc58e5dba31a` on UI main. Candidate is working diff in chatToolIdentity.ts, useChatRun.ts and related four test files plus this fixture. No CSS or production layout files changed.

Actual browser screenshots, same 1440 × 1000 viewport, same fixture, live/completed/failed states expanded:

- Before attachment: `artifacts/attachments/2026-11-11T15-18-57-281Z-d548f74d-cb93-40a9-9bc4-5760de794518-1-mcp-image-1.jpg`
- After attachment: `artifacts/attachments/2026-11-11T15-20-41-115Z-5a872bfa-c958-423b-a8ac-7e8103759dee-1-mcp-image-1.jpg`

These are runtime attachment IDs, not filesystem paths. Reopen with attachment_view when available. Screenshots were inspected by builder. Before shows `mod agent tool`; after shows `notebook` at identical card placement and sizes. Browser snapshot also confirmed `notebook` live/in completed/error lists. Click collapsed the completed card; Enter reopened it.

Test receipts: targeted identity/projection/stream tests: 82 passed. Transcript test file: 79 passed. Build passed after correcting optional items typing in new test; only existing Vite chunk-size warning. Build log `/tmp/smatchet-mod-identity-build.log`. Full-suite log `/tmp/smatchet-mod-identity-tests.log` and completion exit code `/tmp/smatchet-mod-identity-tests.exit` when available. Diff whitespace and targeted Prettier checks passed.

## Contract / limitation

UI consumes explicit top-level `modToolName` only when `tool === 'mod_agent_tool'`, falling back to `Mod tool` if missing/invalid. No arguments, results, or arbitrary labels are used for mod identity/detail. Completed stored labels with no original identity metadata cannot be retroactively reconstructed by this helper. Backend transport and durable server activity are Hatchet's separate responsibility.

## Final verification and independent acceptance

Full isolated suite completed: **230 files, 2,216 tests passed**, exit `0`. Build passed; targeted Prettier and `git diff --check` passed.

Fresh reviewer: **gpt-6-luna**, child `subagent-1794410574363-f5c8a62d`, reviewed the candidate working tree against base `e341d9c645289d97cb655a02a950fc58e5dba31a` before commit. Verdicts: **functional correctness/regressions — Pass; operator scope/layout/behavior — Pass**. No UI defect found. Reviewer inspected source and completed test/build logs; it did not initiate those runs. **Independent visual limitation:** child could not reopen either attachment (`attachment_not_found`) and had no browser tool. Actual comparable screenshots and keyboard disclosure behavior were verified directly by Smatchet, not independently by reviewer.

Hatchet confirmed backend raw execution events carry `modToolName`, but compact progress and durable activity summaries still need his propagation fix. He directed committing this accepted UI candidate while holding push until backend review is complete. No deploy or restart authorized or performed.
