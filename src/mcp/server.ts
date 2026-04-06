import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { createDefaultRegistry } from '../commands/registry.js';
import { runToolRequest } from '../core/tool_runtime.js';

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
    },
    required: ['request'],
    additionalProperties: false,
  },
};

function shellQuote(arg: string) {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function createPipelineForDraft(args: Record<string, unknown>) {
  const parts = ['workflows.generate_draft'];
  const request = String(args.request ?? '').trim();
  if (!request) {
    throw new Error('generate_workflow_draft requires request');
  }
  parts.push('--request', shellQuote(request));

  const mappings: Array<[string, string]> = [
    ['destination', '--destination'],
    ['provider', '--provider'],
    ['model', '--model'],
    ['studioUrl', '--studio-url'],
  ];
  for (const [key, flag] of mappings) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(flag, shellQuote(value.trim()));
    }
  }
  return parts.join(' ');
}

function envelopeToToolResult(envelope: any) {
  if (!envelope?.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: envelope?.error?.message ?? 'Unknown Lobster MCP error' }],
    };
  }

  const first = Array.isArray(envelope.output) ? envelope.output[0] : null;
  return {
    content: [{ type: 'text', text: JSON.stringify(first, null, 2) }],
    structuredContent: first,
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
      result: { tools: [GENERATE_TOOL] },
    };
  }

  if (request.method === 'tools/call') {
    const params = request.params ?? {};
    const name = params.name;
    if (name !== GENERATE_TOOL.name) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32602, message: `Unknown tool: ${name ?? 'undefined'}` },
      };
    }

    try {
      const pipeline = createPipelineForDraft(params.arguments ?? {});
      const envelope = await runToolRequest({
        pipeline,
        ctx: {
          env: process.env,
          cwd: process.cwd(),
          registry: createDefaultRegistry(),
          stdin: process.stdin,
          stdout: silentWritable,
          stderr: silentWritable,
        },
      });
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: envelopeToToolResult(envelope),
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
