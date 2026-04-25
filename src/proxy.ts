import { StitchToolClient } from '@google/stitch-sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { normalizeJsonSchema } from './schema-normalizer.js';

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
}

const DEFAULT_EMPTY_INPUT_SCHEMA = {
  additionalProperties: true,
  properties: {},
  type: 'object',
} as const;

interface StitchToolClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callTool(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
  connect(): Promise<void>;
  listTools(): Promise<{ tools: UpstreamTool[] }>;
}

export function createStitchClientFromEnv(
  env: StitchProxyEnvironment = process.env,
): StitchToolClient {
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

  const config: Record<string, string> = {};

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

  return new StitchToolClient(config);
}

export class StitchToolClientAdapter implements UpstreamToolAdapter {
  readonly #client: StitchToolClientLike;
  #connectPromise: Promise<void> | null = null;
  #connected = false;

  constructor(client: StitchToolClient = createStitchClientFromEnv()) {
    this.#client = client as StitchToolClientLike;
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

function normalizeTool(tool: UpstreamTool): UpstreamTool {
  return {
    ...tool,
    inputSchema: normalizeJsonSchema(
      tool.inputSchema ?? DEFAULT_EMPTY_INPUT_SCHEMA,
    ) as Record<string, unknown>,
    ...(tool.outputSchema && {
      outputSchema: normalizeJsonSchema(tool.outputSchema) as Record<string, unknown>,
    }),
  };
}

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
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
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
    // If structuredContent is already present, pass through unchanged
    if (raw.structuredContent) {
      return raw;
    }

    // Tool has outputSchema — derive structuredContent from text content
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

/**
 * Heuristic check for error-like results from the Stitch SDK.
 * The SDK's parseToolResponse throws StitchError for isError results,
 * so this mainly guards against stray { isError: true } objects.
 */
function isErrorResult(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isError' in value &&
    (value as { isError: unknown }).isError === true
  );
}

export class StitchCompatibilityProxy {
  readonly #adapter: UpstreamToolAdapter;
  readonly #server: Server;
  /** Cache of tool definitions keyed by name, populated on listTools. */
  #toolCache = new Map<string, UpstreamTool>();

  constructor(options: StitchCompatibilityProxyOptions) {
    this.#adapter = options.adapter;
    this.#server = new Server(
      options.serverInfo ?? {
        name: 'stitch-proxy-ld9',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        instructions:
          options.instructions ??
          'Compatibility proxy that normalizes Stitch tool schemas and adapts callTool results for local MCP clients.',
      },
    );

    this.#server.setRequestHandler(ListToolsRequestSchema, async () => {
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

    this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const raw = await this.#adapter.callTool({
        arguments: request.params.arguments as Record<string, unknown> | undefined,
        name: toolName,
      });

      const cachedTool = this.#toolCache.get(toolName);
      const toolHasOutputSchema = cachedTool != null && cachedTool.outputSchema != null;

      return adaptCallToolResult(raw, toolHasOutputSchema);
    });
  }

  async close(): Promise<void> {
    await this.#adapter.close();
    await this.#server.close();
  }

  async start(transport: Transport = new StdioServerTransport()): Promise<void> {
    await this.#server.connect(transport);
  }
}
