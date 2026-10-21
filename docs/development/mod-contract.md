# Third-party mod contract

This page is the public author contract for **ordinary third-party Burrow mods**. The companion [Burrow Tutor](https://github.com/GoblinKing-Burrow/Burrow-Tutor) is an installable, deliberately boring implementation.

!!! warning "Trusted code, not a sandbox"
    A mod is executable server and/or browser code. The forked host contains faults and narrows Core APIs, but is not an operating-system sandbox. Install only code you trust.

Privileged `system: true` mods and `systemCapabilities` are Core integration contracts, not ordinary third-party APIs.

## Package and releases

A repository contains one root `burrow.mod.json`; server/UI files use safe relative paths. Burrow installs the highest accepted tagged snapshot, not an arbitrary branch tip. Tags may be `YYYY.MM.DD[.N]`, SemVer, or either prefixed with `v`. A manifest `version` must match the tag after removing `v`.

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "2026.10.20",
  "server": "server/index.mjs",
  "ui": { "control": "ui/control.js", "settings": "ui/settings.js" }
}
```

`id` is lowercase kebab form, must match the install directory, and cannot be `mod-data`. `name` is required. Unknown fields are not capability negotiation.

A Settings module normally adds `contributions.settings` with 1–12 lowercase-kebab IDs. Each needs navigation/primary titles and `primary.capability: "settingsUi"`; `apiTargets` is supported only when a matching mod route target is declared.

## Activation and cleanup

Server ESM exports `activate(context)`. Register routes/tools/diagnostics during activation. It may return nothing, cleanup, or `{close()}`. Context exposes `id`, `api`, `tools`, `diagnostics`, `runtimeDiagnostics`, `settings`, `secrets`, `agents`, `operator`, `conversations`, `models`, `scheduler`, and `logger`.

```js
export async function activate(context) {
  context.api.get('/status', async () => ({ ok: true }));
  return () => {};
}
```

## JSON routes

Use `context.api.get/post/put/patch/delete(path, handler)`. Paths are beneath `/api/mods/<id>`, `/` is the root, and `:parameters` are supported. Traversal, query/fragment text, encoded segments, malformed params, and duplicate method/path pairs fail activation.

Handlers receive `{auth:{enabled,authenticated},body,query,params,method,path,headers}`. Auth is trusted Core context; request data cannot forge it. API tokens are not operator sessions. Credential headers are stripped. Validate all inputs and apply domain authorization.

Return JSON or `{status?,headers?,body?}`. Generic routes are JSON-only. The normal route/tool deadline is 30 seconds; start durable long work asynchronously.

## Settings, secrets, and data

```js
await context.settings.get('name', fallback)
await context.settings.set('name', jsonValue)
await context.settings.delete('name')
await context.secrets.get('token')
await context.secrets.set('token', stringValue)
await context.secrets.has('token')
await context.secrets.clear('token')
```

Core binds storage to the manifest ID. Settings are JSON; secrets are encrypted strings. Empty/null secret writes clear. Never return secrets through routes, logs, tools, or UI initialization; expose a configured boolean instead. Settings/secrets survive update and uninstall.

Optional persistent files belong under `$BURROW_RUNTIME_ROOT/mods/mod-data/<id>/`. Core preserves this directory; the mod owns its schema, locking, encryption, backup, migration, and deletion.

## Agent tools

```js
context.tools.register({
  name: 'my_lookup',
  description: 'Look up a record.',
  inputSchema: { type:'object', additionalProperties:false, properties:{id:{type:'string'}}, required:['id'] },
  async handler(args, caller) {
    if (caller.signal.aborted) throw new Error('cancelled');
    return { ok:true, id:args.id };
  }
});
```

Names allow letters/digits/`.`/`_`/`-`; schemas must be JSON-serializable object schemas. Core AJV-validates without coercion/defaults/stripping; handlers still own domain validation. Arguments are model-supplied. Caller identity and abort signal are frozen Core context.

Tools publish under `mod.<id>`. Default `grant-required` availability uses per-agent MCP grants; installation grants nothing. Advanced `mod-authorized` tools must enforce their own per-agent/per-record authorization. Secrets require documented protected-result envelopes; ordinary JSON is visible.

## Generic Core capabilities

Ordinary mods may call `agents.list`, operator identity/timezone, paged conversation list/read, model list/generateText, and owner-scoped scheduler list/read/create/update/delete/runs/trigger. Model credentials remain in Core; generation uses `tools:null` and does not mutate chat. Scheduler jobs are bound to the mod. Use the scheduler, not private recurring timers. At most four generic capability calls are active per mod.

## UI modules

UI is trusted browser ESM. Assets in declared UI directories can be publicly served; keep server code/secrets elsewhere. Scoped `api(path,init?)` prefixes the mod namespace.

Control exports `mountControl({modId,root,api})` and may return cleanup or `{unmount}`.

Settings exports lowercase-kebab `settingsSections` and `mountSettings({modId,runtimeScope,section,agents,primary,overflow,api,accessApi,refreshAgents,saveAgentExecutionEnvironment})`. Surfaces expose `replace`, `replaceChildren`, and `clear`. Ordinary mods normally need only `section`, `primary`, and `api`. Declarative `settingsContribution`/`createSettingsContribution` is also supported.

Archive exports `mountArchive({modId,runtimeScope,root,api,date})`; `date` is `YYYY-MM-DD` or empty. Return cleanup or `{update?,unmount?}`.

## Lifecycle and compatibility

Flow: add Git source, refresh, install, explicitly enable, separately grant tools, then update/disable/uninstall. Fresh installs start disabled. Updates preserve enabled state. Active work can return busy. Disable removes live routes/tools. Uninstall removes code/catalog/grants but preserves settings, secrets, and mod-data.

Burrow has no manifest `apiVersion` or Core range yet. This page plus the reference mod define the current public contract. Breaking changes require coordinated Core docs/reference updates. Test against every release you claim to support.

## Release checklist

Validate route/tool input; trust only Core identity; never return/log secrets; honor cancellation; clean up; test activation/auth/rejection/repeat/cleanup/UI; integration-test current Core; match manifest version to tag; publish an accepted tag; and verify install/enable/use/disable/update/uninstall in development.
