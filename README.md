# stitch-proxy-ld9

Independent, experimental local MCP stdio compatibility proxy for Google Stitch.

Its only job is to sit between a local MCP client and Stitch, normalize incompatible JSON Schema patterns in tool `inputSchema`, and then forward tool calls unchanged.

## Why this exists

Google Stitch MCP tool schemas can include JSON Schema objects like:

```json
{
  "$ref": "#/$defs/VariantOptions",
  "description": "Variant configuration"
}
```

That shape is valid in newer JSON Schema dialects, but Moonshot-flavored Draft 7 rejects `$ref` with sibling keywords. This proxy rewrites that shape to:

```json
{
  "allOf": [{ "$ref": "#/$defs/VariantOptions" }],
  "description": "Variant configuration"
}
```

## Scope

- Runs as a **local MCP server over stdio**.
- Uses `@google/stitch-sdk` to access upstream Stitch tools.
- Intercepts `tools/list` and recursively normalizes every tool `inputSchema`.
- Forwards `tools/call` unchanged.
- Uses **environment variables only** for credentials.
- Does **not** log secrets.

## Status

This is an **independent compatibility proxy**, not an official Google package.

Google Stitch APIs and SDKs are still experimental. Expect surface-area changes.

## Naming

- MCP server name: `stitch-proxy-ld9`
- Package name: `stitch-proxy-ld9`

This package name remains valid for npm because unscoped names cannot **start** with `_`, but `_` is otherwise URL-safe and allowed in the name.

## Required environment variables

Choose one auth mode:

### API key

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

## Install

```bash
npm install
```

## Run locally

```bash
npm run start
```

This uses `tsx` directly, so you do not need a build step for local MVP usage.

## OpenCode project-local example config

`opencode.example.json` is an EXAMPLE ONLY. It is committed as documentation and does not store secrets.

If you want to use a project-local OpenCode config for manual testing, copy it to a non-committed location that OpenCode can read, or point OpenCode at it explicitly with your own workflow. Keep using shell-exported environment variables for credentials.

### Example file in this repo

```json
{
  "mcp": {
    "stitch-proxy-ld9": {
      "type": "local",
      "command": [
        "npx",
        "tsx",
        "/mnt/SSD/code/02-Proyectos/stitch_proxy/src/index.ts"
      ],
      "environment": {
        "STITCH_API_KEY": "{env:STITCH_API_KEY}"
      }
    }
  }
}
```

## OpenCode config examples

### Project-local server entry

```json
{
  "mcp": {
    "stitch-proxy-ld9": {
      "type": "local",
      "command": ["npx", "tsx", "/mnt/SSD/code/02-Proyectos/stitch_proxy/src/index.ts"],
      "environment": {
        "STITCH_API_KEY": "{env:STITCH_API_KEY}"
      }
    }
  }
}
```

### Access token variant

```json
{
  "mcp": {
    "stitch-proxy-ld9": {
      "type": "local",
      "command": ["npx", "tsx", "/mnt/SSD/code/02-Proyectos/stitch_proxy/src/index.ts"],
      "environment": {
        "STITCH_ACCESS_TOKEN": "{env:STITCH_ACCESS_TOKEN}",
        "STITCH_PROJECT_ID": "{env:STITCH_PROJECT_ID}",
        "STITCH_HOST": "{env:STITCH_HOST}"
      }
    }
  }
}
```

## OpenCode + Kimi local test flow

This flow assumes:

- you are testing the proxy from source with `tsx`
- you will export `STITCH_API_KEY` in your shell
- you will NOT store secrets in repo files or global OpenCode config

### 1) Install dependencies

From `/mnt/SSD/code/02-Proyectos/stitch_proxy`:

```bash
npm install
```

### 2) Export the Stitch API key in the same shell

```bash
export STITCH_API_KEY="your-api-key"
```

Quick sanity check:

```bash
test -n "$STITCH_API_KEY" && printf 'STITCH_API_KEY is set\n'
```

### 3) Configure the local MCP server command in OpenCode

Use this server entry:

```json
{
  "mcp": {
    "stitch-proxy-ld9": {
      "type": "local",
      "command": [
        "npx",
        "tsx",
        "/mnt/SSD/code/02-Proyectos/stitch_proxy/src/index.ts"
      ],
      "environment": {
        "STITCH_API_KEY": "{env:STITCH_API_KEY}"
      }
    }
  }
}
```

Why this shape:

- `npx tsx .../src/index.ts` matches the current source-only setup
- `{env:STITCH_API_KEY}` keeps credentials outside the repo
- absolute path avoids path-resolution issues when OpenCode is started elsewhere

### 4) Start OpenCode with Kimi

If your OpenCode install already knows a Kimi model id, start it directly with that model:

```bash
opencode --model "YOUR_KIMI_MODEL_ID"
```

If you prefer to select it interactively:

```bash
opencode
```

Then select your Kimi model from the model picker used by your OpenCode install.

### 5) Prompt OpenCode to verify the proxy

Use a direct prompt such as:

```text
List the available MCP tools from stitch-proxy-ld9, then show the first tool name and summarize whether its input schema contains allOf wrappers around any $ref sibling definitions.
```

If the upstream Stitch account has projects or workspaces exposed through its tools, a second useful prompt is:

```text
Use stitch-proxy-ld9 to list available Stitch tools and identify any tool that can enumerate projects, files, or workspaces.
```

### 6) Expected success symptoms

- OpenCode connects to `stitch-proxy-ld9` without failing during tool discovery.
- The proxy process stays alive instead of exiting immediately.
- Tool listing succeeds.
- Kimi can inspect tool schemas without a JSON Schema validation failure.
- When a Stitch tool includes `$ref` plus sibling keywords like `description` or `title`, the exposed schema shows `allOf: [{ "$ref": ... }]` plus the sibling fields.

### 7) Expected failure symptoms

- Startup failure: `Missing Stitch credentials. Set STITCH_API_KEY or STITCH_ACCESS_TOKEN.`
- Startup failure: `STITCH_PROJECT_ID is required when using STITCH_ACCESS_TOKEN.`
- OpenCode cannot start the MCP server because `npx` or `tsx` is unavailable in the environment.
- Tool discovery fails with a Kimi/Moonshot JSON Schema complaint about `$ref` having sibling keywords.
- The server path is wrong, so OpenCode cannot launch `/mnt/SSD/code/02-Proyectos/stitch_proxy/src/index.ts`.

## Troubleshooting

### Original Kimi schema error

If the original Kimi problem comes back, it usually means OpenCode is seeing the upstream Stitch schema directly instead of the normalized proxy schema.

Typical symptom patterns:

- a JSON Schema validation error during MCP tool discovery
- an error mentioning `$ref` with sibling keywords
- an error mentioning Draft 7 compatibility, `description`, or `title` next to `$ref`

What to check:

1. Confirm OpenCode is pointed at `stitch-proxy-ld9`, not the upstream Stitch server directly.
2. Confirm the MCP command uses `npx tsx /mnt/SSD/code/02-Proyectos/stitch_proxy/src/index.ts`.
3. Confirm `STITCH_API_KEY` is exported in the SAME shell/session that launches OpenCode.
4. Confirm dependencies were installed in this repo with `npm install`.

### How to confirm schemas are normalized

The normalization logic is covered by tests in:

- `tests/schema-normalizer.test.ts`
- `tests/proxy.test.ts`

You can confirm the behavior locally by running:

```bash
npm test
```

What you are specifically confirming:

- pure `$ref` objects stay unchanged
- `$ref` plus siblings are rewritten to `allOf: [{ "$ref": ... }]`
- nested tool schemas are normalized recursively
- the normalization is non-mutating
- the proxy returns normalized schemas through the MCP `tools/list` path

## Design notes

- `src/schema-normalizer.ts` is pure and non-mutating.
- `src/proxy.ts` keeps an adapter boundary (`UpstreamToolAdapter`) so the upstream transport can be swapped later if you want to proxy through a different Stitch MCP process.
- The current MVP uses `StitchToolClient` directly because it is the smallest reliable path for schema interception.

## Verification

```bash
npm test
npm run typecheck
```
