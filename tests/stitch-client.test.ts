import { afterEach, describe, expect, test, vi } from 'vitest';

import { StitchHttpClient } from '../src/stitch-client.js';

describe('StitchHttpClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('redacts secrets from failed upstream HTTP response errors', async () => {
    const upstreamBody = [
      'STITCH_API_KEY=stitch-secret-from-upstream',
      'X-Goog-Api-Key: configured-api-key',
      'Authorization: Bearer upstream-bearer-token',
      'api_key: AIzaSyASecretLikeGoogleApiKeyValue123456',
    ].join('\n');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(upstreamBody, {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const client = new StitchHttpClient({
      apiKey: 'configured-api-key',
      baseUrl: 'https://stitch.example.test/mcp',
    });

    await expect(client.connect()).rejects.toThrow(/Stitch MCP HTTP 500/);

    try {
      await client.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toContain('stitch-secret-from-upstream');
      expect(message).not.toContain('upstream-bearer-token');
      expect(message).not.toContain('AIzaSyASecretLikeGoogleApiKeyValue123456');
      expect(message).not.toContain('configured-api-key');
      expect(message).toContain('[REDACTED]');
      return;
    }

    throw new Error('Expected connect to reject');
  });

  test('redacts secrets from JSON-RPC error messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: [
            'Authorization: Bearer json-rpc-bearer-token',
            'STITCH_ACCESS_TOKEN=json-rpc-access-token',
            'api_key: AIzaSyJsonRpcSecretLikeGoogleApiKeyValue123456',
          ].join('\n'),
        },
      }),
    );

    const client = new StitchHttpClient({
      accessToken: 'configured-access-token',
      projectId: 'test-project',
      baseUrl: 'https://stitch.example.test/mcp',
    });

    const error = await client.listTools().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/Stitch MCP error -32000/);
    expect(message).not.toContain('json-rpc-bearer-token');
    expect(message).not.toContain('json-rpc-access-token');
    expect(message).not.toContain('AIzaSyJsonRpcSecretLikeGoogleApiKeyValue123456');
    expect(message).toContain('[REDACTED]');
  });

  test('redacts secrets from SSE JSON-RPC error messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32001,
            message: [
              'Authorization: Bearer sse-bearer-token',
              'STITCH_API_KEY=sse-api-key',
              'api_key: AIzaSySseSecretLikeGoogleApiKeyValue123456',
            ].join('\n'),
          },
        })}\n\n`,
        {
          headers: {
            'content-type': 'text/event-stream',
          },
        },
      ),
    );

    const client = new StitchHttpClient({
      apiKey: 'configured-api-key',
      baseUrl: 'https://stitch.example.test/mcp',
    });

    const error = await client.listTools().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/Stitch MCP error -32001/);
    expect(message).not.toContain('sse-bearer-token');
    expect(message).not.toContain('sse-api-key');
    expect(message).not.toContain('AIzaSySseSecretLikeGoogleApiKeyValue123456');
    expect(message).not.toContain('configured-api-key');
    expect(message).toContain('[REDACTED]');
  });
});
