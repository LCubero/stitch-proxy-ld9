import type { Readable, Writable } from 'node:stream';

import { StitchHttpClient, type StitchClientConfig } from './stitch-client.js';
import { StdioMcpServer } from './mcp-stdio.js';
import { normalizeJsonSchema } from './schema-normalizer.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ContentBlock {
  type: 'text';
  text: string;
}

export interface CallToolResult {
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface UpstreamTool {
  annotations?: Record<string, unknown>;
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  outputSchema?: Record<string, unknown>;
  title?: string;
}

export interface ToolCallRequest {
  arguments?: Record<string, unknown>;
  name: string;
}

/**
 * Adapter for the upstream Stitch tool source.
 *
 * callTool returns `unknown` because the real Stitch SDK's callTool
 * invokes parseToolResponse, which strips the CallToolResult envelope and
 * returns the parsed payload (structuredContent, JSON object, or string).
 * Test mocks may return proper CallToolResult objects — both paths are
 * handled by adaptCallToolResult in the proxy.
 */
export interface UpstreamToolAdapter {
  callTool(request: ToolCallRequest): Promise<unknown>;
  close(): Promise<void>;
  listTools(): Promise<UpstreamTool[]>;
}

export interface StitchProxyEnvironment {
  STITCH_ACCESS_TOKEN?: string;
  STITCH_API_KEY?: string;
  STITCH_HOST?: string;
  STITCH_PROJECT_ID?: string;
}

export interface StitchCompatibilityProxyOptions {
  adapter: UpstreamToolAdapter;
  instructions?: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  input?: Readable;
  output?: Writable;
}

const DEFAULT_EMPTY_INPUT_SCHEMA = {
  additionalProperties: true,
  properties: {},
  type: 'object',
} as const;

// ── Stitch Client Factory ──────────────────────────────────────────────────

export function createStitchClientFromEnv(
  env: StitchProxyEnvironment = process.env,
): StitchHttpClient {
  if (!env.STITCH_API_KEY && !env.STITCH_ACCESS_TOKEN) {
    throw new Error(
      'Missing Stitch credentials. Set STITCH_API_KEY or STITCH_ACCESS_TOKEN.',
    );
  }

  if (env.STITCH_ACCESS_TOKEN && !env.STITCH_PROJECT_ID) {
    throw new Error(
      'STITCH_PROJECT_ID is required when using STITCH_ACCESS_TOKEN.',
    );
  }

  const config: StitchClientConfig = {};

  if (env.STITCH_API_KEY) {
    config.apiKey = env.STITCH_API_KEY;
  }

  if (env.STITCH_ACCESS_TOKEN) {
    config.accessToken = env.STITCH_ACCESS_TOKEN;
  }

  if (env.STITCH_PROJECT_ID) {
    config.projectId = env.STITCH_PROJECT_ID;
  }

  if (env.STITCH_HOST) {
    config.baseUrl = env.STITCH_HOST;
  }

  return new StitchHttpClient(config);
}

// ── Stitch Client Adapter ──────────────────────────────────────────────────

export class StitchToolClientAdapter implements UpstreamToolAdapter {
  readonly #client: StitchHttpClient;
  #connectPromise: Promise<void> | null = null;
  #connected = false;

  constructor(client?: StitchHttpClient) {
    this.#client = client ?? createStitchClientFromEnv();
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) {
      return;
    }

    if (!this.#connectPromise) {
      this.#connectPromise = this.#client
        .connect()
        .then(() => {
          this.#connected = true;
        })
        .finally(() => {
          this.#connectPromise = null;
        });
    }

    await this.#connectPromise;
  }

  async callTool(request: ToolCallRequest): Promise<unknown> {
    await this.#ensureConnected();
    // HTTP client returns raw CallToolResult (with content array),
    // unlike the SDK which strips the envelope via parseToolResponse.
    return this.#client.callTool(request.name, request.arguments);
  }

  async close(): Promise<void> {
    await this.#client.close();
    this.#connected = false;
    this.#connectPromise = null;
  }

  async listTools(): Promise<UpstreamTool[]> {
    await this.#ensureConnected();
    const { tools } = await this.#client.listTools();
    return tools as UpstreamTool[];
  }
}

// ── Schema Normalization ───────────────────────────────────────────────────

function normalizeTool(tool: UpstreamTool): UpstreamTool {
  return {
    ...tool,
    inputSchema: normalizeJsonSchema(
      tool.inputSchema ?? DEFAULT_EMPTY_INPUT_SCHEMA,
    ) as Record<string, unknown>,
    ...(tool.outputSchema && {
      outputSchema: normalizeJsonSchema(tool.outputSchema) as Record<
        string,
        unknown
      >,
    }),
  };
}

// ── CallTool Result Adaptation ─────────────────────────────────────────────

/**
 * Type guard: checks whether `value` looks like a CallToolResult
 * (has a `content` array of content blocks).
 */
function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    Array.isArray((value as CallToolResult).content)
  );
}

/**
 * Attempt to extract structured data from a CallToolResult's text content.
 * Returns the first successfully parsed JSON object, or undefined.
 */
function extractStructuredContentFromText(
  result: CallToolResult,
): Record<string, unknown> | undefined {
  for (const block of result.content) {
    if (block.type === 'text') {
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON — keep looking
      }
    }
  }

  return undefined;
}

/**
 * Heuristic check for error-like results from the Stitch SDK.
 */
function isErrorResult(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isError' in value &&
    (value as { isError: unknown }).isError === true
  );
}

/**
 * Adapt an upstream callTool result into a valid CallToolResult.
 *
 * The Stitch SDK's callTool returns parsed data (not a CallToolResult envelope)
 * because it runs parseToolResponse internally. This function ensures the proxy
 * always returns a properly shaped CallToolResult to downstream MCP clients.
 *
 * When a tool declares an outputSchema, the MCP protocol requires that the
 * callTool response includes `structuredContent`. If the upstream result lacks
 * it, this function derives it from the text content or raw payload.
 */
export function adaptCallToolResult(
  raw: unknown,
  toolHasOutputSchema: boolean,
): CallToolResult {
  // ── Case 1: Already a valid CallToolResult ──────────────────────────
  if (isCallToolResult(raw)) {
    if (raw.structuredContent) {
      return raw;
    }

    if (toolHasOutputSchema && !raw.isError) {
      const structuredContent = extractStructuredContentFromText(raw);
      if (structuredContent) {
        return { ...raw, structuredContent };
      }
    }

    return raw;
  }

  // ── Case 2: Raw parsed data (from StitchToolClient.parseToolResponse) ─
  if (toolHasOutputSchema && !isErrorResult(raw)) {
    const structuredContent =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : undefined;

    return {
      content: [
        {
          type: 'text' as const,
          text: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
        },
      ],
      ...(structuredContent ? { structuredContent } : {}),
    };
  }

  // ── Case 3: No outputSchema — wrap as text content ──────────────────
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
      },
    ],
  };
}

// ── Proxy ──────────────────────────────────────────────────────────────────

export class StitchCompatibilityProxy {
  readonly #adapter: UpstreamToolAdapter;
  readonly #server: StdioMcpServer;
  /** Cache of tool definitions keyed by name, populated on listTools. */
  #toolCache = new Map<string, UpstreamTool>();

  constructor(options: StitchCompatibilityProxyOptions) {
    this.#adapter = options.adapter;
    this.#server = new StdioMcpServer({
      serverInfo: options.serverInfo ?? {
        name: 'stitch-proxy-ld9',
        version: '0.2.0',
      },
      instructions:
        options.instructions ??
        'Compatibility proxy that normalizes Stitch tool schemas and adapts callTool results for local MCP clients.',
      input: options.input,
      output: options.output,
    });

    this.#server.on('tools/list', async () => {
      const tools = await this.#adapter.listTools();

      // Refresh the tool cache so callTool knows which tools have outputSchema
      this.#toolCache.clear();
      for (const tool of tools) {
        this.#toolCache.set(tool.name, tool);
      }

      return {
        tools: tools.map((tool) => normalizeTool(tool)),
      };
    });

    this.#server.on('tools/call', async (request) => {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const toolName = params.name as string;
      const args = params.arguments as Record<string, unknown> | undefined;

      const raw = await this.#adapter.callTool({
        arguments: args,
        name: toolName,
      });

      const cachedTool = this.#toolCache.get(toolName);
      const toolHasOutputSchema =
        cachedTool != null && cachedTool.outputSchema != null;

      return adaptCallToolResult(raw, toolHasOutputSchema);
    });
  }

  async close(): Promise<void> {
    await this.#adapter.close();
  }

  async start(): Promise<void> {
    await this.#server.start();
  }
}
