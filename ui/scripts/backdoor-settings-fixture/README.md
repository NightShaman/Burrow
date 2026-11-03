# Backdoor host integration fixture

`settings.js` is an unmodified snapshot of NightShaman/Burrow-Backdoor `ui/settings.js` at commit `e3229ea1a4e721c34f5e2bb590cb6c3137fec690` (draft PR #2). Source: https://github.com/NightShaman/Burrow-Backdoor/blob/e3229ea1a4e721c34f5e2bb590cb6c3137fec690/ui/settings.js

The host regression dynamically imports this actual imperative module through ModSettingsHost. Network responses are synthetic; the host, module, confirmation and unsaved-change providers are real. Do not replace the import with a handcrafted layout attribute or a mock mount. Update the source pin when refreshing the fixture. This is not a live browser/pixel test.
