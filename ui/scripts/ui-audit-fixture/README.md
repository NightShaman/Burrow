# Owned FE040/041/042/054 browser fixture

Build: `node scripts/ui-audit-fixture/build.mjs`. Serve: `python3 scripts/ui-audit-fixture/serve.py` (binds 0.0.0.0, OS-selected port 0). Server exposes only `bundle/`, not the repository. React and actual repaired UI modules/CSS are bundled from installed local dependencies. No backend is started; controls mutate in-memory fixture state only. CSP denies all connections and permits images only from self/data/blob.

## Parent acceptance procedure

1. Open the recorded Hatchet URL; verify no uncaught errors or API/network requests. At desktop width, select themes (especially Paper, Terminal, High Contrast). Inspect checked participant border/fill, selected profile background/border, Queued status and hint text. Contrast/pixel closure requires browser evidence.
2. Focus **Destructive confirmation**, activate, verify **Cancel** receives focus, Tab/Shift+Tab stay in dialog, background cannot receive focus or clicks, Escape cancels and returns focus to opener. Test Cancel and Confirm separately. **Queue confirmations** must show First then Second, with Cancel safe on both and both results settled. Open **New session** and repeat trap/Escape/restore; submit its actual form. Open image preview, test Actual size/Fit, Tab cycling, Escape/close/backdrop, opener restoration.
3. Keyboard-select First/Second document tabs with arrows, Home/End; verify selected and focused tab agree. Use Move up/down for agents and accounts and verify displayed order. Focus each Resize separator; ArrowUp/Down increments 5, Home/End reaches 25/75; read split values below controls. Tab to visible **Stop fixture run**, activate and verify stopped receipt.
4. At 320, 375, 600 CSS px and desktop 200%/400% zoom, scroll vertically through existing rails and toolbar. Select Ada/Bea, expand/select each child, change planning/review session, provider/model, effort and temperature. Essential controls must remain visible/reachable and usable, with no page-level horizontal overflow. Inspect modal scrolling at each width.

## Limits

The fixture mounts actual ConfirmProvider, AccessibleModal (through session/image/confirm), ChatComposerDialogs, DocumentTabs, WorkspaceRail/AgentsPanel, RightRail/CodexAccounts, AgentSidebarSettings and ChatModelSelector. Group Stop and theme regression samples use actual repaired CSS with inert local sample markup; no production group/API run occurs. OAuth/task/mod/wizard composition and dream listbox have isolated tests/source/build coverage but are not mounted here. Pointer split dragging is intentionally a no-op in the fixture; production pointer behavior is preserved. No assistive-technology certification or visual closure is claimed.
