# Backdoor host integration fixture

`settings.js` is an exact snapshot of NightShaman/Burrow-Backdoor `ui/settings.js` at commit `a305dcceabcdbb374702dafaa8fd57de24436eac`.
Source: https://github.com/NightShaman/Burrow-Backdoor/blob/a305dcceabcdbb374702dafaa8fd57de24436eac/ui/settings.js

The host regression dynamically imports this actual imperative module through ModSettingsHost. Network responses are synthetic; the host, module, confirmation and unsaved-change providers are real. Do not replace the import with a handcrafted layout attribute or mock mount. Update the source pin when refreshing the fixture. This is not a live browser/pixel test.

Global Access retains single-form layout. Admin Access uses opt-in `form-wide` and `.settings-section-pair` to keep independent management/Core API assignments side by side with one shared draft and Save below. Ordinary single forms remain left-half on desktop.
