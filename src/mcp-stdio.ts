/**
 * Minimal MCP stdio transport.
 *
 * Implements just enough of the Model Context Protocol over stdin/stdout
 * to support tool listing and calling. No HTTP, no SSE, no Express.
 *
 * Protocol: JSON-RPC 2.0 with newline-delimited messages.
 */

import type { Readable, Writable } from 'node:stream';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type MessageHandler = (
  request: JsonRpcRequest,
) => Promise<unknown> | unknown;

/**
 * Minimal MCP stdio server.
 *
 * Reads JSON-RPC messages from stdin, dispatches to handlers,
 * writes responses to stdout.
 */
export class StdioMcpServer {
  readonly #serverInfo: { name: string; version: string };
  readonly #instructions?: string;
  readonly #handlers = new Map<string, MessageHandler>();
  readonly #input: Readable;
  readonly #output: Writable;
  #buffer = '';

  constructor(options: {
    serverInfo: { name: string; version: string };
    instructions?: string;
    input?: Readable;
    output?: Writable;
  }) {
    this.#serverInfo = options.serverInfo;
    this.#instructions = options.instructions;
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
  }

  /**
   * Register a handler for a JSON-RPC method.
   */
  on(method: string, handler: MessageHandler): void {
    this.#handlers.set(method, handler);
  }

  /**
   * Start reading from stdin and writing to stdout.
   * Resolves when stdin closes.
   */
  async start(): Promise<void> {
    // Register built-in MCP methods
    this.on('initialize', () => ({
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.#serverInfo,
      ...(this.#instructions ? { instructions: this.#instructions } : {}),
    }));

    this.on('notifications/initialized', () => undefined);

    this.on('ping', () => ({}));

    return new Promise<void>((resolve) => {
      this.#input.setEncoding('utf-8');

      this.#input.on('data', (chunk: string) => {
        this.#buffer += chunk;
        this.#processBuffer();
      });

      this.#input.on('end', () => {
        resolve();
      });

      this.#input.on('error', () => {
        resolve();
      });
    });
  }

  #processBuffer(): void {
    let newlineIndex: number;

    while ((newlineIndex = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      try {
        const message = JSON.parse(line) as JsonRpcRequest;
        void this.#handleMessage(message);
      } catch (err) {
        // Ignore malformed JSON, but log for debugging
        console.error('Stitch MCP: failed to parse message on stdin:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  async #handleMessage(message: JsonRpcRequest): Promise<void> {
    // Notifications (no id) don't get responses
    const isNotification = message.id === undefined;

    const handler = this.#handlers.get(message.method);

    if (!handler) {
      if (!isNotification) {
        this.#send({
          jsonrpc: '2.0',
          id: message.id!,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`,
          },
        });
      }
      return;
    }

    try {
      const result = await handler(message);

      if (!isNotification) {
        this.#send({
          jsonrpc: '2.0',
          id: message.id!,
          result: result ?? undefined,
        });
      }
    } catch (error) {
      if (!isNotification) {
        this.#send({
          jsonrpc: '2.0',
          id: message.id!,
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : 'Internal error',
          },
        });
      }
    }
  }

  #send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    this.#output.write(`${json}\n`);
  }
}
