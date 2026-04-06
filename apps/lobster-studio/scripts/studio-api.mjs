import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function resolveRuntimeModule(relativeCandidates) {
  for (const candidate of relativeCandidates) {
    const candidatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), candidate);
    if (existsSync(candidatePath)) {
      return pathToFileURL(candidatePath);
    }
  }
  throw new Error(`Unable to locate Studio runtime module from ${fileURLToPath(import.meta.url)}`);
}

const distToolRuntimeUrl = resolveRuntimeModule([
  '../../../dist/src/core/tool_runtime.js',
  '../../../src/core/tool_runtime.js',
]);
const distWorkflowUrl = resolveRuntimeModule([
  '../../../dist/src/workflows/file.js',
  '../../../src/workflows/file.js',
]);

async function loadModules() {
  const [{ runToolRequest }, { loadWorkflowFile }] = await Promise.all([
    import(distToolRuntimeUrl),
    import(distWorkflowUrl),
  ]);
  return { runToolRequest, loadWorkflowFile };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function withTemporaryWorkflow(text, tempRoot, fn) {
  const tempDir = await mkdtemp(path.join(tempRoot, 'lobster-studio-'));
  const filePath = path.join(tempDir, 'working-copy.lobster');
  try {
    await writeFile(filePath, text, 'utf8');
    return await fn(filePath, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function parseStudioWorkflowText({ text, tempRoot = os.tmpdir() }) {
  const { loadWorkflowFile } = await loadModules();
  try {
    const workflow = await withTemporaryWorkflow(text, tempRoot, async (filePath) => loadWorkflowFile(filePath));
    return { ok: true, workflow };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function normalizeStudioTestEnvelope(envelope) {
  if (!envelope?.ok) {
    return {
      status: 'error',
      message: envelope?.error?.message || 'Studio test failed.',
    };
  }

  if (envelope.status === 'needs_approval') {
    return {
      status: 'unsupported-approval',
      message: 'Approval-required workflows are not supported in Lobster Studio tests yet.',
    };
  }

  if (envelope.status === 'cancelled') {
    return {
      status: 'error',
      message: 'Studio test was cancelled.',
    };
  }

  return {
    status: 'success',
    message: 'Lobster test passed.',
    output: Array.isArray(envelope.output) ? envelope.output : [],
  };
}

export async function runStudioWorkflowTest({
  text,
  cwd = repoRoot,
  env = process.env,
  tempRoot = os.tmpdir(),
}) {
  const { runToolRequest } = await loadModules();
  try {
    const envelope = await withTemporaryWorkflow(text, tempRoot, async (filePath) => runToolRequest({
      filePath,
      ctx: {
        cwd,
        env,
        mode: 'tool',
      },
    }));

    return {
      ok: true,
      result: normalizeStudioTestEnvelope(envelope),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleStudioApiRequest(req, res, pathname, options = {}) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, 400, {
      error: error instanceof Error ? error.message : 'Invalid JSON body',
    });
    return true;
  }

  const text = typeof payload?.text === 'string' ? payload.text : '';
  if (!text.trim()) {
    jsonResponse(res, 400, { error: 'Request body must include workflow text.' });
    return true;
  }

  if (pathname === '/api/parse-workflow') {
    const result = await parseStudioWorkflowText({
      text,
      tempRoot: options.tempRoot,
    });
    jsonResponse(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (pathname === '/api/test-workflow') {
    const result = await runStudioWorkflowTest({
      text,
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      tempRoot: options.tempRoot,
    });
    jsonResponse(res, result.ok ? 200 : 500, result);
    return true;
  }

  return false;
}
