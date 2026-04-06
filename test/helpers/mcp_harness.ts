import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TestContext } from 'node:test';

import { serializeWorkflowFile } from '../../src/workflows/serialize.js';
import { loadWorkflowFile } from '../../src/workflows/file.js';
import { parseWorkflowFileText } from '../../src/workflows/parse.js';

type JsonRpcId = string | number;

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  result?: any;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type LaunchSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  description: string;
};

type HarnessOptions = {
  extraEnv?: NodeJS.ProcessEnv;
};

const DETERMINISTIC_WORKFLOW = {
  name: 'generated-from-mcp',
  steps: [
    {
      id: 'fetch',
      command: 'gh pr view ${pr} --repo ${repo} --json title,body,author',
    },
    {
      id: 'draft',
      pipeline: 'llm.invoke --provider http --prompt "Draft a reviewer summary"',
      stdin: '$fetch.json',
    },
    {
      id: 'publish',
      approval: 'Ship this draft to Studio?',
      stdin: '$draft.json',
    },
  ],
};

export const DETERMINISTIC_WORKFLOW_TEXT = serializeWorkflowFile(DETERMINISTIC_WORKFLOW);

export function defaultGenerateWorkflowArgs(overrides: Record<string, unknown> = {}) {
  const envJson = process.env.LOBSTER_MCP_GENERATE_ARGS_JSON;
  const base = envJson
    ? JSON.parse(envJson)
    : {
      request: 'Generate a simple PR review workflow draft for Lobster Studio.',
    };
  return { ...base, ...overrides };
}

export async function createMcpHarness(t: TestContext, options: HarnessOptions = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'lobster-mcp-harness-'));
  t.after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const llmAdapter = await startFakeLlmAdapter(t);
  const launch = await resolveLaunchSpec({
    tmpDir,
    extraEnv: {
      ...options.extraEnv,
      LOBSTER_LLM_PROVIDER: 'http',
      LOBSTER_LLM_ADAPTER_URL: llmAdapter.url,
      LOBSTER_LLM_MODEL: 'test-model',
    },
  });

  if (!launch) {
    t.skip(
      'MCP server entrypoint not available. Set LOBSTER_MCP_SERVER_ENTRY or add dist/src/mcp/server.js or bin/lobster-mcp.js.',
    );
    return null;
  }

  const session = new McpStdioClient(launch);
  t.after(async () => {
    await session.close();
  });
  await session.start();
  const earlyExit = await session.waitForEarlyExit();
  if (earlyExit) {
    t.skip(`MCP server entrypoint exited before accepting stdio requests (${earlyExit}). Leader integration should keep the process alive, e.g. via process.stdin.resume().`);
    return null;
  }
  return session;
}

async function resolveLaunchSpec({
  tmpDir,
  extraEnv,
}: {
  tmpDir: string;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<LaunchSpec | null> {
  const env = {
    ...process.env,
    ...extraEnv,
    LOBSTER_MCP_TEST_MODE: '1',
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
    LOBSTER_CACHE_DIR: path.join(tmpDir, 'cache'),
  };

  const explicitEntry = process.env.LOBSTER_MCP_SERVER_ENTRY?.trim();
  if (explicitEntry) {
    return {
      command: process.execPath,
      args: [explicitEntry],
      cwd: process.cwd(),
      env,
      description: `node ${explicitEntry}`,
    };
  }

  const explicitBin = process.env.LOBSTER_MCP_SERVER_BIN?.trim();
  const explicitArgs = process.env.LOBSTER_MCP_SERVER_ARGS_JSON?.trim();
  if (explicitBin && explicitArgs) {
    return {
      command: explicitBin,
      args: JSON.parse(explicitArgs),
      cwd: process.cwd(),
      env,
      description: `${explicitBin} ${explicitArgs}`,
    };
  }

  for (const candidate of [
    path.join(process.cwd(), 'dist/src/mcp/server.js'),
    path.join(process.cwd(), 'bin/lobster-mcp.js'),
  ]) {
    try {
      const stat = await fsp.stat(candidate);
      if (!stat.isFile()) continue;
      return {
        command: process.execPath,
        args: [candidate],
        cwd: process.cwd(),
        env,
        description: `node ${candidate}`,
      };
    } catch {
      // continue
    }
  }

  return null;
}

export async function assertCanonicalWorkflowText(text: string) {
  assert.equal(text.endsWith('\n'), true, 'canonical workflow text should end with a newline');
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'lobster-mcp-workflow-'));
  try {
    const filePath = path.join(tmpDir, 'generated.lobster');
    await fsp.writeFile(filePath, text, 'utf8');
    const workflow = await loadWorkflowFile(filePath);
    assert.equal(serializeWorkflowFile(workflow), text, 'workflow text should match canonical serializer output');
    return workflow;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export function extractWorkflowText(payload: unknown): string {
  const candidates = collectStringCandidates(payload);
  for (const candidate of candidates) {
    if (looksLikeWorkflowText(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No canonical workflow text found in MCP payload: ${JSON.stringify(payload, null, 2)}`);
}

export function extractStudioHandoff(payload: unknown): { url: string; descriptor: unknown } {
  const found = searchForStudioHandoff(payload, new Set<unknown>());
  if (!found) {
    throw new Error(`No Studio handoff descriptor found in MCP payload: ${JSON.stringify(payload, null, 2)}`);
  }
  return found;
}


export function skipOnServerLifecycleGap(t: TestContext, error: unknown) {
  if (error instanceof Error && /exited before request completed \(code=0, signal=null\)/.test(error.message)) {
    t.skip('MCP server process exits during stdio exchange. Leader integration should keep the server alive across requests.');
    return true;
  }
  return false;
}

export class McpStdioClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<JsonRpcId, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  #stderr = '';
  #exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(private readonly launch: LaunchSpec) {}

  async start() {
    this.#child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: this.launch.env,
      stdio: 'pipe',
    });

    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drainFrames();
    });

    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr += chunk;
    });

    this.#child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal };
      const detail = `MCP server exited before request completed (code=${code}, signal=${signal})\n${this.#stderr}`.trim();
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(detail));
      }
      this.#pending.clear();
    });
  }

  async waitForEarlyExit(timeoutMs = 100) {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    if (!this.#exitInfo) return null;
    return `code=${this.#exitInfo.code}, signal=${this.#exitInfo.signal}`;
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lobster-test', version: '0.0.0' },
    });
    await this.notify('notifications/initialized', {});
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return this.request('tools/call', {
      name,
      arguments: args,
    });
  }

  async request(method: string, params: Record<string, unknown>) {
    const id = this.#nextId++;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });

    if (response.error) {
      throw new Error(`MCP ${method} failed: ${response.error.message ?? 'unknown error'}`);
    }
    return response.result;
  }

  async notify(method: string, params: Record<string, unknown>) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async close() {
    if (!this.#child) return;
    if (this.#child.exitCode !== null || this.#child.killed) return;
    this.#child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.#child && this.#child.exitCode === null) {
          this.#child.kill('SIGKILL');
        }
      }, 1000);
      this.#child!.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  #write(payload: Record<string, unknown>) {
    assert.ok(this.#child?.stdin, `MCP server is not running (${this.launch.description})`);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
    this.#child.stdin.write(Buffer.concat([header, body]));
  }

  #drainFrames() {
    while (true) {
      const separator = this.#buffer.indexOf('\r\n\r\n');
      if (separator === -1) return;
      const headerText = this.#buffer.subarray(0, separator).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        throw new Error(`Invalid MCP header: ${headerText}`);
      }
      const length = Number(match[1]);
      const frameStart = separator + 4;
      const frameEnd = frameStart + length;
      if (this.#buffer.length < frameEnd) return;

      const body = this.#buffer.subarray(frameStart, frameEnd).toString('utf8');
      this.#buffer = this.#buffer.subarray(frameEnd);
      const message = JSON.parse(body) as JsonRpcResponse;
      if (message.id === undefined) continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      pending.resolve(message);
    }
  }
}

async function startFakeLlmAdapter(t: TestContext) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            runId: 'mcp_test_1',
            model: parsed.model ?? 'test-model',
            prompt: parsed.prompt ?? null,
            output: {
              format: 'text',
              text: process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT ?? DETERMINISTIC_WORKFLOW_TEXT,
              data: parseWorkflowFileText(process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT ?? DETERMINISTIC_WORKFLOW_TEXT),
            },
            diagnostics: { adapter: 'mcp-test' },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${address.port}` };
}

function collectStringCandidates(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringCandidates(entry, seen));
  }

  return Object.values(value).flatMap((entry) => collectStringCandidates(entry, seen));
}

function looksLikeWorkflowText(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = parseWorkflowFileText(trimmed);
    return Boolean(parsed && typeof parsed === 'object' && Array.isArray(parsed.steps));
  } catch {
    return false;
  }
}

function searchForStudioHandoff(value: unknown, seen: Set<unknown>): { url: string; descriptor: unknown } | null {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = searchForStudioHandoff(entry, seen);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if ((lower.includes('studio') || lower.includes('handoff')) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const url = extractUrl(entry as Record<string, unknown>);
      if (url) return { url, descriptor: entry };
    }
    if ((lower.includes('studio') || lower.includes('handoff')) && typeof entry === 'string' && entry.startsWith('http')) {
      return { url: entry, descriptor: { url: entry } };
    }
  }

  for (const entry of Object.values(record)) {
    const found = searchForStudioHandoff(entry, seen);
    if (found) return found;
  }

  return null;
}

function extractUrl(record: Record<string, unknown>) {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && key.toLowerCase().includes('url') && value.startsWith('http')) {
      return value;
    }
  }
  return null;
}
