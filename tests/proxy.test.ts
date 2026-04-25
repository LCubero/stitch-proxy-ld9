import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';

import type { StitchHttpClient } from '../src/stitch-client.js';
import type { CallToolResult } from '../src/proxy.js';
import {
  adaptCallToolResult,
  StitchCompatibilityProxy,
  StitchToolClientAdapter,
  type UpstreamToolAdapter,
} from '../src/proxy.js';

function createCallToolResult(): CallToolResult {
  return {
    content: [{ text: 'ok', type: 'text' }],
  };
}

// ── Helpers for integration tests ──────────────────────────────────────────

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

function sendRequest(
  input: PassThrough,
  output: PassThrough,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  return new Promise<JsonRpcResponse>((resolve) => {
    let buffer = '';

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        output.removeListener('data', onData);
        resolve(JSON.parse(line) as JsonRpcResponse);
      }
    };

    output.on('data', onData);
    input.write(`${JSON.stringify(request)}\n`);
  });
}

// ── StitchToolClientAdapter ────────────────────────────────────────────────

describe('StitchToolClientAdapter', () => {
  test('connects lazily before listing tools and calling tools', async () => {
    const result = createCallToolResult();
    const connect = vi.fn(async function (this: { connected: boolean }) {
      this.connected = true;
    });
    const client = {
      callTool: vi.fn(async function (
        this: { connected: boolean },
        name: string,
        args?: Record<string, unknown>,
      ) {
        if (!this.connected) {
          throw new Error('client not connected');
        }

        expect(name).toBe('generate_screen_from_text');
        expect(args).toEqual({ prompt: 'Generate a hero section.' });
        return result;
      }),
      close: vi.fn(async () => undefined),
      connect,
      connected: false,
      listTools: vi.fn(async function (this: { connected: boolean }) {
        if (!this.connected) {
          throw new Error('client not connected');
        }

        return {
          tools: [{ name: 'list_projects' }],
        };
      }),
    } as unknown as StitchHttpClient;

    const adapter = new StitchToolClientAdapter(client);

    await expect(adapter.listTools()).resolves.toEqual([{ name: 'list_projects' }]);
    await expect(
      adapter.callTool({
        arguments: { prompt: 'Generate a hero section.' },
        name: 'generate_screen_from_text',
      }),
    ).resolves.toBe(result);

    expect(connect).toHaveBeenCalledOnce();
  });

  test('reuses the same in-flight connect call for concurrent requests', async () => {
    let resolveConnect: (() => void) | undefined;
    const connect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const client = {
      callTool: vi.fn(async () => createCallToolResult()),
      close: vi.fn(async () => undefined),
      connect,
      listTools: vi.fn(async () => ({ tools: [] })),
    } as unknown as StitchHttpClient;

    const adapter = new StitchToolClientAdapter(client);

    const first = adapter.listTools();
    const second = adapter.listTools();

    expect(connect).toHaveBeenCalledTimes(1);

    resolveConnect?.();

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test('forwards tool arguments unchanged', async () => {
    const result = createCallToolResult();
    const callTool = vi.fn(async () => result);
    const client = {
      callTool,
      close: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [] })),
    } as unknown as StitchHttpClient;

    const adapter = new StitchToolClientAdapter(client);
    const args = { prompt: 'Generate a hero section.' };

    await expect(
      adapter.callTool({ arguments: args, name: 'generate_screen_from_text' }),
    ).resolves.toBe(result);

    expect(callTool).toHaveBeenCalledWith('generate_screen_from_text', args);
  });

  test('preserves missing arguments as undefined', async () => {
    const result = createCallToolResult();
    const callTool = vi.fn(async () => result);
    const client = {
      callTool,
      close: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [] })),
    } as unknown as StitchHttpClient;

    const adapter = new StitchToolClientAdapter(client);

    await expect(
      adapter.callTool({ name: 'generate_screen_from_text' }),
    ).resolves.toBe(result);

    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith('generate_screen_from_text', undefined);
    expect(callTool).not.toHaveBeenCalledWith('generate_screen_from_text', {});
  });
});

// ── adaptCallToolResult ──────────────────────────────────────────────────

describe('adaptCallToolResult', () => {
  test('passes through a CallToolResult that already has structuredContent', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: '{"projects":[]}' }],
      structuredContent: { projects: [] },
    };
    expect(adaptCallToolResult(result, true)).toBe(result);
  });

  test('derives structuredContent from JSON text when tool has outputSchema', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: '{"projects":[{"id":"abc"}]}' }],
    };
    const adapted = adaptCallToolResult(result, true);
    expect(adapted).toEqual({
      content: [{ type: 'text', text: '{"projects":[{"id":"abc"}]}' }],
      structuredContent: { projects: [{ id: 'abc' }] },
    });
  });

  test('does not add structuredContent when tool has no outputSchema', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: '{"projects":[]}' }],
    };
    const adapted = adaptCallToolResult(result, false);
    expect(adapted).toEqual(result);
  });

  test('does not add structuredContent when result is an error', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    };
    const adapted = adaptCallToolResult(result, true);
    expect(adapted).toEqual(result);
  });

  test('wraps a raw object with structuredContent when tool has outputSchema', () => {
    const raw = { projects: [{ id: 'abc', name: 'My Project' }] };
    const adapted = adaptCallToolResult(raw, true);
    expect(adapted).toEqual({
      content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }],
      structuredContent: raw,
    });
  });

  test('wraps a raw string as text content without structuredContent', () => {
    const adapted = adaptCallToolResult('hello world', false);
    expect(adapted).toEqual({
      content: [{ type: 'text', text: 'hello world' }],
    });
  });

  test('wraps a raw object as text content when tool has no outputSchema', () => {
    const raw = { key: 'value' };
    const adapted = adaptCallToolResult(raw, false);
    expect(adapted).toEqual({
      content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }],
    });
  });

  test('handles raw string when tool has outputSchema (no structuredContent)', () => {
    const adapted = adaptCallToolResult('just text', true);
    expect(adapted).toEqual({
      content: [{ type: 'text', text: 'just text' }],
    });
  });

  test('preserves error CallToolResult without structuredContent even when tool has outputSchema', () => {
    const raw = { isError: true, content: [{ type: 'text', text: 'failed' }] };
    const adapted = adaptCallToolResult(raw, true);
    expect(adapted).toEqual({
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    });
    expect('structuredContent' in adapted).toBe(false);
  });
});

// ── StitchCompatibilityProxy integration ──────────────────────────────────

describe('StitchCompatibilityProxy', () => {
  test('normalizes tools/list schemas through the MCP proxy layer', async () => {
    const adapter: UpstreamToolAdapter = {
      callTool: vi.fn(async () => createCallToolResult()),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [
        {
          description: 'Generates a screen from text.',
          inputSchema: {
            $defs: {
              VariantOptions: {
                additionalProperties: false,
                properties: { size: { type: 'string' } },
                type: 'object',
              },
            },
            properties: {
              component: {
                properties: {
                  variantOptions: {
                    $ref: '#/$defs/VariantOptions',
                    description: 'Variant configuration for this component.',
                  },
                },
                type: 'object',
              },
            },
            type: 'object',
          },
          name: 'generate_screen_from_text',
        },
      ]),
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const proxy = new StitchCompatibilityProxy({ adapter, input, output });

    // Start proxy (non-blocking)
    void proxy.start();

    // Send initialize
    const initResp = await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.1.0' },
      },
    });
    expect(initResp.result).toMatchObject({ protocolVersion: '2024-11-05' });

    // Send tools/list
    const toolsResp = await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const tools = (toolsResp.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('generate_screen_from_text');
    expect(tools[0].inputSchema).toMatchObject({
      properties: {
        component: {
          properties: {
            variantOptions: {
              allOf: [{ $ref: '#/$defs/VariantOptions' }],
              description: 'Variant configuration for this component.',
            },
          },
          type: 'object',
        },
      },
    });

    input.destroy();
    await proxy.close();
  });

  test('normalizes outputSchema $ref siblings in tools/list', async () => {
    const adapter: UpstreamToolAdapter = {
      callTool: vi.fn(async () => createCallToolResult()),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [
        {
          description: 'List all projects.',
          inputSchema: { type: 'object', properties: {} },
          name: 'list_projects',
          outputSchema: {
            $defs: {
              ProjectSummary: {
                properties: { id: { type: 'string' }, name: { type: 'string' } },
                type: 'object',
              },
            },
            properties: {
              projects: {
                $ref: '#/$defs/ProjectSummary',
                description: 'List of projects.',
              },
            },
            type: 'object',
          },
        },
      ]),
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const proxy = new StitchCompatibilityProxy({ adapter, input, output });
    void proxy.start();

    await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.1.0' },
      },
    });

    const toolsResp = await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const tools = (toolsResp.result as { tools: Array<{ outputSchema?: Record<string, unknown> }> }).tools;
    expect(tools[0].outputSchema).toMatchObject({
      properties: {
        projects: {
          allOf: [{ $ref: '#/$defs/ProjectSummary' }],
          description: 'List of projects.',
        },
      },
    });

    input.destroy();
    await proxy.close();
  });

  test('adapts raw object result to CallToolResult with structuredContent when tool has outputSchema', async () => {
    const projectsData = { projects: [{ id: 'abc', name: 'My Project' }] };

    const adapter: UpstreamToolAdapter = {
      callTool: vi.fn(async () => projectsData),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [
        {
          description: 'List all projects.',
          inputSchema: { type: 'object', properties: {} },
          name: 'list_projects',
          outputSchema: {
            properties: { projects: { type: 'array' } },
            type: 'object',
          },
        },
      ]),
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const proxy = new StitchCompatibilityProxy({ adapter, input, output });
    void proxy.start();

    await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.1.0' },
      },
    });

    // List tools first so proxy caches metadata
    await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    // Call tool
    const callResp = await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    });

    const result = callResp.result as CallToolResult;
    expect(result).toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: { projects: [{ id: 'abc', name: 'My Project' }] },
    });

    input.destroy();
    await proxy.close();
  });

  test('passes through CallToolResult without structuredContent when tool has no outputSchema', async () => {
    const callResult: CallToolResult = {
      content: [{ type: 'text', text: 'Design created!' }],
    };

    const adapter: UpstreamToolAdapter = {
      callTool: vi.fn(async () => callResult),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [
        {
          description: 'Generate a screen from text.',
          inputSchema: { type: 'object', properties: {} },
          name: 'generate_screen_from_text',
        },
      ]),
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const proxy = new StitchCompatibilityProxy({ adapter, input, output });
    void proxy.start();

    await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.1.0' },
      },
    });

    await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const callResp = await sendRequest(input, output, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'generate_screen_from_text', arguments: { prompt: 'A hero' } },
    });

    const result = callResp.result as CallToolResult;
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Design created!' }],
    });
    expect('structuredContent' in result).toBe(false);

    input.destroy();
    await proxy.close();
  });
});
