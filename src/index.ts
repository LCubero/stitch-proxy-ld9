#!/usr/bin/env node

import {
  StitchCompatibilityProxy,
  StitchToolClientAdapter,
} from './proxy.js';

const SERVER_INFO = {
  name: 'stitch-proxy-ld9',
  version: '0.1.0',
};

async function main(): Promise<void> {
  const proxy = new StitchCompatibilityProxy({
    adapter: new StitchToolClientAdapter(),
    instructions:
      'Independent compatibility proxy for Google Stitch MCP. Normalizes JSON Schema $ref sibling patterns for Moonshot Kimi-compatible MCP clients.',
    serverInfo: SERVER_INFO,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`${SERVER_INFO.name}: received ${signal}, shutting down.`);
    await proxy.close();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await proxy.start();
  console.error(`${SERVER_INFO.name}: ready on stdio.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal startup error: ${message}`);
  process.exit(1);
});
