# Extending Burrow

Choose the smallest extension boundary that owns the behavior you need.

| Need | Extension point |
|---|---|
| Reusable operating instructions | Skill |
| Persistent agent identity or working guidance | Profile documents |
| An external service capability | MCP provider |
| Runtime-integrated tools, routes or UI contributions | Mod |
| A new provider wire protocol | Model adapter in Core |

A skill does not install a tool or grant permission. Mods run executable code; a child host separates lifecycle and failures but is not an operating-system sandbox.

## Create a skill

Use the [Burrow Skills authoring guide](https://docs.goblin-kingdom.com/burrow-skills/authoring/) for `SKILL.md`, companion files and validation. Ordinary operator-owned skills can be imported and assigned through Settings. Official managed copies are maintained by their source and are not customized in place; see [Skills and memory](../guide/skills-and-memory.md).

## Add an MCP capability

Configure the provider, discover tools and apply the relevant access controls. Ordinary MCP connections and mod-managed providers do not necessarily expose the same grant UI. A discovered tool is not evidence that a call will be authorized. See [MCP](../concepts/mcp.md) and [Tools and mods](../guide/tools-and-mods.md).

## Build a mod

Use [Burrow Tutor](https://docs.goblin-kingdom.com/burrow-tutor/) as the runnable example, and its [contract walkthrough](https://docs.goblin-kingdom.com/burrow-tutor/contract/) for manifests, routes, tools, storage, UI and lifecycle. Read the checked source/version limits before treating an example as compatible with an older installed Core.

Minimal manifest:

```json
{
  "id": "example-status",
  "name": "Example status",
  "version": "2026.10.25",
  "server": "server.mjs"
}
```

A server module exports `activate(context)`, registers only its own routes/tools and returns cleanup when needed. Validate arguments in the handler and handle cancellation. Installation, enablement, ordinary tool grants and privileged system-mod capabilities are separate concerns; a manifest cannot grant itself Core authority.

The current authoring material follows inspected development source. [Release status](../project/release-status.md) distinguishes that work from public snapshots and installed versions. Tutor’s [installation readiness](https://docs.goblin-kingdom.com/burrow-tutor/install/#release-readiness) records a verified public tag; select an actual accepted tag with a matching manifest rather than inventing one from a default branch.

## Mod-owned native agents

Current development Core provides a generic host contract for a mod to own native agent identities and supply their per-turn context. Register `context.agents.context.register(provider)` during activation. The provider receives `{ agentId, sessionId }` plus `{ signal }`, and returns only `profileFiles` and `context`, each an array of `{ name, content }` string records. Names are bounded non-path identifiers, unique within each collection; each collection accepts at most 64 records and the combined UTF-8 name/content budget is 1,000,000 bytes. Invalid or excess provider output is rejected, not silently trimmed.

`context.agents.owned.create`, `.list`, `.read` and `.update` are scoped to the installed owner. Core assigns ownership. Creation requires an authenticated, existing enabled native model and stores identity/model selection atomically. Supported capability flags are `a2a`, `forge`, `brains`, `mcp`, `skills`; visibility flags are `agents`, `chat`. Omitted flags default false; update patches preserve omitted flags. These records do not imply engineering/tool access, profile documents or a Dream cycle.

The live owner provider is required for dependent turns. Disablement, host failure/replacement, a missing provider, timeout or invalid output fails with `mod_agent_unavailable`. Context is selected by logical conversation session ID, including fresh scheduled turns. The native bridge reaches only the owner's current published tools, independently of external MCP. See [runtime context construction](../architecture/runtime.md#mod-owned-native-context).

Owned `referenceImages.get`, `.put` and `.remove` use the canonical agent reference store. Portable settings preserve ownership/capability/visibility records; restoring an unavailable owner leaves its agent unavailable, and conflicting regular/mod or different-owner identities are rejected. This host contract is not a separate public HTTP endpoint or a guarantee that every declared flag is exposed by every route.

## Extend a model adapter

Provider wire protocols belong in Core's model-adapter layer. Test request construction, supported options, streaming, tool continuations, error handling and credential boundaries against that provider's contract. A model name alone does not establish support for every endpoint or capability.

## Development checklist

1. Choose the smallest correct owner.
2. Validate inputs and preserve trusted caller identity.
3. Bound output and failure behavior.
4. Test activation, rejection, cancellation, cleanup and repeated calls.
5. Verify disabled or ungranted capabilities remain unavailable.
6. Update documentation alongside the behavior.
7. Publish through the supported tagged release process rather than editing an active installation.

## Full home-Core API capability

Current Core supports the independently declared and operator-granted `core-api-v1` system capability. `context.coreApi.request` requires a live tool invocation, trusted Core-bound caller and membership in the mod's Core-owned `adminAgentIds` on each admission. It is full administrative access to the home Core API, not the managed read-only diagnostics subset, a remote proxy or a GET-only endpoint allowlist. Activations, background work and detached callbacks cannot use a completed invocation's authority. Revocation blocks subsequent admissions; it does not undo already admitted side effects.

Requests accept a local `/api` path and optional method, headers, and exactly one of JSON `body`, UTF-8 `bodyText` or `bodyBase64`. Responses preserve status, headers, encoding, original byte length and complete finite body; HTTP errors remain response data. Finite NDJSON is aggregated, not delivered incrementally. The default 96 MiB response allocation ceiling fails explicitly rather than returning truncated success. Response failure does not roll back an already executed mutation; reconcile before retrying.

This capability does not automatically grant other host interfaces or cross-agent managed diagnostics. Neither tool arguments nor headers establish trusted caller authority. Task-board mutations retain the actual agent/session/run attribution. Use [Backdoor's current API guidance](https://docs.goblin-kingdom.com/burrow-backdoor/operator-api/) for the shipped tool surface; a skill itself grants none of these capabilities.

## 3 November development delta

The changed context and host contracts above were checked statically against Backend `32dde3266a231777ddfec6dba141d6b9972a21fd` on **2026-11-03**. No application, provider or database tests were run; unchanged historical sections retain their earlier qualifications. See [source coverage](../project/source-map.md).
