#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function load() {
  const distEntry = join(__dirname, '../dist/src/mcp/index.js');
  if (existsSync(distEntry)) {
    return import(distEntry);
  }
  return import(join(__dirname, '../src/mcp/index.js'));
}

const mod = await load();
if (typeof mod.runMcpServer !== 'function') {
  throw new Error('lobster MCP entrypoint missing runMcpServer()');
}

await mod.runMcpServer();
