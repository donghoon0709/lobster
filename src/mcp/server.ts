import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { createDefaultRegistry } from '../commands/registry.js';
import { applyExistingWorkflowEdit, editExistingWorkflow } from '../workflows/edit_existing.js';
import { generateWorkflowDraft } from '../workflows/generate_draft.js';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type TransportMode = 'unknown' | 'framed' | 'raw';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'lobster-mcp';
const SERVER_VERSION = '0.2.1';
const HEADER_SEPARATOR = '\r\n\r\n';
const LINE_SEPARATOR = '\r\n';
const silentWritable = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const GENERATE_TOOL: ToolDefinition = {
  name: 'generate_workflow_draft',
  description: 'Generate a canonical Lobster workflow draft from natural language and prepare a Lobster Studio handoff.',
  inputSchema: {
    type: 'object',
    properties: {
      request: { type: 'string', description: 'Natural-language workflow request' },
      destination: { type: 'string', description: 'Optional destination file path for the canonical .lobster file' },
      provider: { type: 'string', description: 'Optional llm.invoke provider override' },
      model: { type: 'string', description: 'Optional llm.invoke model override' },
      studioUrl: { type: 'string', description: 'Optional Lobster Studio base URL override' },
      validate: { type: 'boolean', description: 'Enable conditional auto-validation and bounded self-repair (default: true for MCP).' },
      workflowArgs: { type: 'object', description: 'Optional workflow args used for validation execution when needed.' },
      maxRepairAttempts: { type: 'number', description: 'Optional retry cap for repair attempts (max 3).' },
    },
    required: ['request'],
    additionalProperties: false,
  },
};

const EDIT_TOOL: ToolDefinition = {
  name: 'edit_existing_workflow',
  description: 'Edit an existing .lobster workflow by explicit path, self-test it on a temporary working copy, and return review artifacts without mutating the real file.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Explicit path to the existing .lobster file.' },
      request: { type: 'string', description: 'Natural-language edit request.' },
      provider: { type: 'string', description: 'Optional llm.invoke provider override' },
      model: { type: 'string', description: 'Optional llm.invoke model override' },
      studioUrl: { type: 'string', description: 'Optional Lobster Studio base URL override' },
      validate: { type: 'boolean', description: 'Enable conditional self-test/self-fix on a temporary working copy (default: true).' },
      workflowArgs: { type: 'object', description: 'Optional workflow args used for validation execution when needed.' },
      maxRepairAttempts: { type: 'number', description: 'Optional retry cap for self-fix attempts (max 3).' },
    },
    required: ['filePath', 'request'],
    additionalProperties: false,
  },
};

const APPLY_EDIT_TOOL: ToolDefinition = {
  name: 'apply_existing_workflow_edit',
  description: 'Apply a previously proposed existing-workflow edit to the real .lobster file after explicit approval.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Internal apply/edit session identifier returned by edit_existing_workflow.' },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
};

function envelopeToToolResult(envelope: any) {
  if (!envelope) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Unknown Lobster MCP error' }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    isError: false,
  };
}

function editResultToToolResult(result: any) {
  const userFacing = { ...result };
  delete userFacing.applySessionId;
  return {
    content: [{ type: 'text', text: JSON.stringify(userFacing, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

function writeMessage(message: Record<string, unknown>, mode: TransportMode) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (mode === 'raw') {
    process.stdout.write(`${payload.toString('utf8')}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${payload.length}${HEADER_SEPARATOR}`);
  process.stdout.write(payload);
}

async function handleRequest(request: JsonRpcRequest) {
  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: { tools: [GENERATE_TOOL, EDIT_TOOL, APPLY_EDIT_TOOL] },
    };
  }

  if (request.method === 'tools/call') {
    const params = request.params ?? {};
    const name = params.name;
    if (![GENERATE_TOOL.name, EDIT_TOOL.name, APPLY_EDIT_TOOL.name].includes(String(name))) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32602, message: `Unknown tool: ${name ?? 'undefined'}` },
      };
    }

    try {
      const args = params.arguments ?? {};
      const runtimeCtx = {
        env: process.env,
        cwd: process.cwd(),
        registry: createDefaultRegistry(),
        stdin: process.stdin,
        stdout: silentWritable,
        stderr: silentWritable,
      };
      const result = name === GENERATE_TOOL.name
        ? await generateWorkflowDraft({
          request: String(args.request ?? '').trim(),
          destination: typeof args.destination === 'string' ? args.destination : undefined,
          studioBaseUrl: typeof args.studioUrl === 'string' ? args.studioUrl : undefined,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          validation: {
            enabled: typeof args.validate === 'boolean' ? args.validate : true,
            workflowArgs: args.workflowArgs && typeof args.workflowArgs === 'object' ? args.workflowArgs : undefined,
            maxRepairAttempts: typeof args.maxRepairAttempts === 'number' ? args.maxRepairAttempts : undefined,
          },
          ctx: runtimeCtx,
        })
        : name === EDIT_TOOL.name
          ? await editExistingWorkflow({
            filePath: String(args.filePath ?? '').trim(),
            request: String(args.request ?? '').trim(),
            studioBaseUrl: typeof args.studioUrl === 'string' ? args.studioUrl : undefined,
            provider: typeof args.provider === 'string' ? args.provider : undefined,
            model: typeof args.model === 'string' ? args.model : undefined,
            validation: {
              enabled: typeof args.validate === 'boolean' ? args.validate : true,
              workflowArgs: args.workflowArgs && typeof args.workflowArgs === 'object' ? args.workflowArgs : undefined,
              maxRepairAttempts: typeof args.maxRepairAttempts === 'number' ? args.maxRepairAttempts : undefined,
            },
            ctx: runtimeCtx,
          })
          : await applyExistingWorkflowEdit({
            sessionId: String(args.sessionId ?? '').trim(),
            ctx: runtimeCtx,
          });
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: name === EDIT_TOOL.name ? editResultToToolResult(result) : envelopeToToolResult(result),
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  if (request.method === 'notifications/initialized') {
    return null;
  }

  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    error: { code: -32601, message: `Method not found: ${request.method ?? 'undefined'}` },
  };
}

export async function runMcpServer() {
  let buffer = Buffer.alloc(0);
  let transportMode: TransportMode = 'unknown';
  const keepAlive = setInterval(() => {}, 60_000);

  const processRequest = async (request: JsonRpcRequest) => {
    const response = await handleRequest(request);
    if (response) writeMessage(response, transportMode);
  };

  const processFramedBuffer = async () => {
    while (true) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) return;

      const headerText = buffer.subarray(0, headerEnd).toString('utf8');
      const headers = headerText.split(LINE_SEPARATOR);
      let contentLength = -1;
      for (const header of headers) {
        const match = /^Content-Length:\s*(\d+)$/i.exec(header);
        if (match) {
          contentLength = Number(match[1]);
        }
      }
      if (contentLength < 0) {
        throw new Error('Missing Content-Length header');
      }
      const totalLength = headerEnd + HEADER_SEPARATOR.length + contentLength;
      if (buffer.length < totalLength) return;

      const body = buffer.subarray(headerEnd + HEADER_SEPARATOR.length, totalLength).toString('utf8');
      buffer = buffer.subarray(totalLength);

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body);
      } catch {
        writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 'framed');
        continue;
      }

      transportMode = 'framed';
      await processRequest(request);
    }
  };

  const processRawBuffer = async () => {
    const text = buffer.toString('utf8').trim();
    if (!text) {
      buffer = Buffer.alloc(0);
      return;
    }

    const candidates = text.includes('\n')
      ? text.split('\n').map((line) => line.trim()).filter(Boolean)
      : [text];

    const parsed: JsonRpcRequest[] = [];
    for (const candidate of candidates) {
      try {
        parsed.push(JSON.parse(candidate));
      } catch {
        return;
      }
    }

    buffer = Buffer.alloc(0);
    transportMode = 'raw';
    for (const request of parsed) {
      await processRequest(request);
    }
  };

  const processBuffer = async () => {
    if (buffer.indexOf(HEADER_SEPARATOR) !== -1) {
      await processFramedBuffer();
      return;
    }
    await processRawBuffer();
  };

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    void processBuffer();
  });
  process.stdin.on('close', () => {
    clearInterval(keepAlive);
  });

  process.stdin.resume();
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  await runMcpServer();
}
