# Backdoor host integration fixture

`settings.js` is an exact snapshot of NightShaman/Burrow-Backdoor `ui/settings.js` at commit `d96b01355ea20efab24e2beedd5b7b5aab35531d`.
Source: https://github.com/NightShaman/Burrow-Backdoor/blob/d96b01355ea20efab24e2beedd5b7b5aab35531d/ui/settings.js

The host regression dynamically imports this actual imperative module through ModSettingsHost. Network responses are synthetic; the host, module, confirmation and unsaved-change providers are real. Do not replace the import with a handcrafted layout attribute or mock mount. Update the source pin when refreshing the fixture. This is not a live browser/pixel test.

Global Access is unchanged. Admin Access and Core API Access are separate single-form sections, each using the Global layout and desktop vertical divider. Each section owns its controls, shared navigation guard, and Save while preserving the other scopes on replacement. Single forms remain left-half on desktop.
