/**
 * Minimal Stitch MCP client.
 *
 * Replaces @google/stitch-sdk and @modelcontextprotocol/sdk with
 * direct HTTP calls to the Stitch MCP server using fetch + SSE.
 *
 * Protocol: JSON-RPC 2.0 over Streamable HTTP (POST for requests,
 * SSE for streaming responses).
 */

export interface StitchClientConfig {
  apiKey?: string;
  accessToken?: string;
  projectId?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface StitchTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  title?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const DEFAULT_BASE_URL = 'https://stitch.googleapis.com/mcp';
const DEFAULT_TIMEOUT = 30_000;

export class StitchHttpClient {
  readonly #baseUrl: string;
  readonly #timeout: number;
  readonly #headers: Record<string, string>;
  #sessionId: string | null = null;
  #requestId = 0;

  constructor(config: StitchClientConfig) {
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeout = config.timeout ?? DEFAULT_TIMEOUT;

    this.#headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };

    if (config.apiKey) {
      this.#headers['X-Goog-Api-Key'] = config.apiKey;
    } else if (config.accessToken) {
      this.#headers['Authorization'] = `Bearer ${config.accessToken}`;
      if (config.projectId) {
        this.#headers['X-Goog-User-Project'] = config.projectId;
      }
    }
  }

  async connect(): Promise<void> {
    // Initialize the MCP session
    const result = await this.#sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stitch-proxy-ld9', version: '0.2.0' },
    });

    // Send initialized notification (no response expected)
    await this.#sendNotification('notifications/initialized', {});

    if (!result) {
      throw new Error('Failed to initialize MCP session with Stitch');
    }
  }

  async listTools(): Promise<{ tools: StitchTool[] }> {
    const result = await this.#sendRequest('tools/list', {});
    return result as { tools: StitchTool[] };
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.#sendRequest('tools/call', { name, arguments: args });
  }

  async close(): Promise<void> {
    this.#sessionId = null;
  }

  // ── Private ────────────────────────────────────────────────────────────

  async #sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.#requestId;
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);

    try {
      const headers: Record<string, string> = { ...this.#headers };
      if (this.#sessionId) {
        headers['Mcp-Session-Id'] = this.#sessionId;
      }

      const response = await fetch(this.#baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Capture session ID from response
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) {
        this.#sessionId = sessionId;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Stitch MCP HTTP ${response.status}: ${text || response.statusText}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';

      // Handle SSE response
      if (contentType.includes('text/event-stream')) {
        return this.#parseSseResponse(response, id);
      }

      // Handle JSON response
      const json = (await response.json()) as JsonRpcResponse;
      if (json.error) {
        throw new Error(
          `Stitch MCP error ${json.error.code}: ${json.error.message}`,
        );
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async #sendNotification(method: string, params?: unknown): Promise<void> {
    const body = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const headers: Record<string, string> = { ...this.#headers };
    if (this.#sessionId) {
      headers['Mcp-Session-Id'] = this.#sessionId;
    }

    await fetch(this.#baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }).catch(() => {
      // Notifications don't require a response
    });
  }

  async #parseSseResponse(
    response: Response,
    expectedId: number,
  ): Promise<unknown> {
    const text = await response.text();
    const lines = text.split('\n');

    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue;
      }

      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id === expectedId) {
          if (parsed.error) {
            throw new Error(
              `Stitch MCP error ${parsed.error.code}: ${parsed.error.message}`,
            );
          }
          return parsed.result;
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Stitch MCP error')) {
          throw e;
        }
        // Not valid JSON or not our response, skip
      }
    }

    throw new Error('No matching response found in SSE stream');
  }
}
