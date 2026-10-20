# Extending BURROW

!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Use the current contract linked below for mod authoring.

Choose the smallest extension boundary that owns the behavior you need.

| Need | Extension point |
|---|---|
| Reusable operating instructions | Skill |
| Persistent agent identity or environment facts | Profile documents |
| An external service capability | MCP connection and per-agent grants |
| Runtime-integrated tools, routes, or UI contributions | Mod |
| A new provider wire protocol | Model adapter in backend source |

A skill does not install a tool. A discovered tool does not grant itself to an agent. A mod is executable code, not a permissions sandbox.

## Build a mod

Use the current [third-party mod contract](mod-contract.md) and public [Burrow Reference Mod](https://github.com/NightShaman/Burrow-Reference-Mod) as the canonical authoring sources. They cover manifests, routes, tools, storage, UI, distribution, lifecycle, compatibility, and trust behavior with runnable current-Core tests.

Minimal server shape:

```json
{
  "id": "example-status",
  "name": "Example status",
  "server": "server.mjs"
}
```

```javascript
export async function activate(context) {
  context.api.get('/status', async () => ({ ok: true, version: 1 }));
  context.tools.register({
    name: 'example_status',
    description: 'Return the example mod version.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new Error('invalid_arguments');
      return { ok: true, version: 1 };
    }
  });
  return () => {};
}
```

Install only trusted mod code. The child host isolates lifecycle and faults; it is not an operating-system sandbox. Installation, enablement, and agent tool grants are separate decisions.

## Other extension points

- Read [MCP](../concepts/mcp.md) for external capabilities and per-agent grants.
- Read [Skills and memory](../guide/skills-and-memory.md) for reusable instructions.
- Provider wire protocols belong in Core's model adapter layer and require protocol-specific tests.

## Development checklist

1. Choose the smallest correct extension owner.
2. Validate inputs and preserve trusted caller boundaries.
3. Bound output and failure behavior.
4. Test activation, rejection, cancellation, cleanup, and repeated calls.
5. Confirm disabled/ungranted capabilities remain unavailable.
6. Update contract/reference documentation with behavior changes.
7. Publish a tagged build rather than editing an active install.
