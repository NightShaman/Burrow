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

Use the [Burrow Skills authoring guide](https://burrow-docs.blissful-psychosis.com/burrow-skills/authoring/) for `SKILL.md`, companion files and validation. Ordinary operator-owned skills can be imported and assigned through Settings. Official managed copies are maintained by their source and are not customized in place; see [Skills and memory](../guide/skills-and-memory.md).

## Add an MCP capability

Configure the provider, discover tools and apply the relevant access controls. Ordinary MCP connections and mod-managed providers do not necessarily expose the same grant UI. A discovered tool is not evidence that a call will be authorized. See [MCP](../concepts/mcp.md) and [Tools and mods](../guide/tools-and-mods.md).

## Build a mod

Use [Burrow Tutor](https://burrow-docs.blissful-psychosis.com/burrow-tutor/) as the runnable example, and its [contract walkthrough](https://burrow-docs.blissful-psychosis.com/burrow-tutor/contract/) for manifests, routes, tools, storage, UI and lifecycle. Read the checked source/version limits before treating an example as compatible with an older installed Core.

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

The current authoring material follows inspected development source. [Release status](../project/release-status.md) distinguishes that work from public snapshots and installed versions. Tutor’s [installation readiness](https://burrow-docs.blissful-psychosis.com/burrow-tutor/install/#release-readiness) records a verified public tag; select an actual accepted tag with a matching manifest rather than inventing one from a default branch.

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
