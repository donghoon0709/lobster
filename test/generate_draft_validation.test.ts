import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateWorkflowDraft } from '../src/workflows/generate_draft.js';

function asStream(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function createLlmStub(responses: unknown[]) {
  let index = 0;
  return {
    get(name: string) {
      if (name !== 'llm.invoke') return null;
      return {
        async run() {
          const payload = responses[Math.min(index, responses.length - 1)];
          index += 1;
          return {
            output: asStream([{
              kind: 'llm.invoke',
              source: 'stub',
              model: 'stub-model',
              cached: false,
              output: {
                data: payload,
                text: JSON.stringify(payload),
              },
            }]),
          };
        },
      };
    },
  };
}

function createCtx(responses: unknown[]) {
  return {
    cwd: process.cwd(),
    env: process.env,
    registry: createLlmStub(responses),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    llmAdapters: {},
  };
}

test('generateWorkflowDraft is a one-shot generation flow without validation metadata', async () => {
  const result = await generateWorkflowDraft({
    request: 'Generate a simple echo workflow.',
    ctx: createCtx([{
      name: 'echo-flow',
      steps: [
        {
          id: 'hello',
          command: 'printf ok',
        },
      ],
    }]),
  });

  assert.equal(result.text.includes('printf ok'), true);
  assert.equal(result.studio.url.startsWith('http'), true);
  assert.equal('validation' in result, false);
});

test('generateWorkflowDraft writes the destination file in one pass', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-generate-draft-'));
  const destination = path.join(tmpDir, 'generated.lobster');
  const result = await generateWorkflowDraft({
    request: 'Generate a simple echo workflow.',
    destination,
    ctx: createCtx([{
      name: 'echo-flow',
      steps: [
        {
          id: 'hello',
          command: 'printf ok',
        },
      ],
    }]),
  });

  assert.equal(await fsp.readFile(destination, 'utf8'), result.text);
  assert.equal(result.filePath, destination);
  assert.equal('validation' in result, false);
});

test('generateWorkflowDraft surfaces malformed llm output directly without repair retries', async () => {
  await assert.rejects(
    () => generateWorkflowDraft({
      request: 'Generate a workflow.',
      ctx: {
        ...createCtx([]),
        registry: {
          get(name: string) {
            if (name !== 'llm.invoke') return null;
            return {
              async run() {
                return {
                  output: asStream([{
                    kind: 'llm.invoke',
                    source: 'stub',
                    model: 'stub-model',
                    cached: false,
                    output: {
                      text: '{not json',
                    },
                  }]),
                };
              },
            };
          },
        },
      },
    }),
    /non-JSON draft text/i,
  );
});
