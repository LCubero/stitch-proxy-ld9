# stitch-proxy-ld9

Independent MCP compatibility proxy for Google Stitch. Normalizes JSON Schema patterns that break Moonshot Kimi and other strict Draft 7 clients.

## The problem

Google Stitch MCP emits tool schemas with `$ref` plus sibling keywords:

```json
{ "$ref": "#/$defs/VariantOptions", "description": "..." }
```

This is valid in modern JSON Schema, but Kimi/Moonshot rejects it. This proxy rewrites it to:

```json
{ "allOf": [{ "$ref": "#/$defs/VariantOptions" }], "description": "..." }
```

## Quick install

```bash
npm install -g stitch-proxy-ld9
```

Or use without installing:

```bash
npx -y stitch-proxy-ld9
```

## Configure OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "stitch-proxy-ld9": {
      "type": "local",
      "command": ["stitch-proxy-ld9"],
      "environment": {
        "STITCH_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Or using an environment variable (recommended for shared machines):

```json
{
  "mcp": {
    "stitch-proxy-ld9": {
      "type": "local",
      "command": ["stitch-proxy-ld9"],
      "environment": {
        "STITCH_API_KEY": "{env:STITCH_API_KEY}"
      }
    }
  }
}
```

Then export in your shell profile (`.bashrc`, `.zshrc`):

```bash
export STITCH_API_KEY="your-api-key-here"
```

## Use

Open OpenCode and verify the MCP is connected:

```
/mcp
```

Then prompt:

```text
usa stitch-proxy-ld9 para listar mis proyectos de Stitch
```

```text
usa stitch-proxy-ld9 para listar las pantallas del proyecto X
```

```text
usa stitch-proxy-ld9 para obtener el código HTML de la pantalla Y
```

## Auth modes

### API key (recommended)

```bash
export STITCH_API_KEY="your-api-key"
```

### Access token

```bash
export STITCH_ACCESS_TOKEN="your-access-token"
export STITCH_PROJECT_ID="your-google-cloud-project-id"
```

### Optional host override

```bash
export STITCH_HOST="https://stitch.googleapis.com/mcp"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Missing Stitch credentials` | No API key set | Set `STITCH_API_KEY` in config or shell |
| `Connection closed` in `/mcp` | OpenCode can't see the key | Verify key is in `~/.config/opencode/opencode.json` or exported in shell |
| `tools.function.parameters is not a valid moonshot flavored json schema` | Using upstream Stitch directly | Use `stitch-proxy-ld9`, not `stitch` |
| `structured content` error | Old version | `npm install -g stitch-proxy-ld9@latest` |
| `command not found: stitch-proxy-ld9` | Not installed globally | `npm install -g stitch-proxy-ld9` |

## Verify installation

```bash
# Check binary exists
which stitch-proxy-ld9

# Run tests (from repo clone)
npm test
npm run typecheck
```

## How it works

```
OpenCode + Kimi
  → stitch-proxy-ld9 (local stdio MCP)
    → normalizes $ref + siblings → allOf pattern
      → Google Stitch MCP (remote)
```

- Intercepts `tools/list` and normalizes every `inputSchema`
- Forwards `tools/call` unchanged
- Handles `structuredContent` for tools with `outputSchema`
- Uses env-only auth, no secrets logged

## Status

Independent compatibility proxy. Not affiliated with Google.

Google Stitch APIs are experimental. Expect changes.

## License

MIT
