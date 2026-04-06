import test from 'node:test';
import assert from 'node:assert/strict';

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

test('generateWorkflowDraft keeps generation-only behavior when validation is disabled', async () => {
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

  assert.equal(result.validation.status, 'generation_only');
  assert.equal(result.text.includes('printf ok'), true);
  assert.equal(result.studio.url.startsWith('http'), true);
});

test('generateWorkflowDraft marks approval workflows as validation_skipped', async () => {
  const result = await generateWorkflowDraft({
    request: 'Generate a workflow that needs approval.',
    validation: {
      enabled: true,
    },
    ctx: createCtx([{
      name: 'approval-flow',
      steps: [
        {
          id: 'approve',
          approval: 'Proceed?',
        },
      ],
    }]),
  });

  assert.equal(result.validation.status, 'validation_skipped');
  assert.match(result.validation.blockedReason ?? '', /approval workflows/i);
  assert.equal(result.studio.url.startsWith('http'), true);
});

test('generateWorkflowDraft validates a safe workflow when validation is enabled', async () => {
  const result = await generateWorkflowDraft({
    request: 'Generate a safe workflow.',
    validation: {
      enabled: true,
    },
    ctx: createCtx([{
      name: 'safe-flow',
      steps: [
        {
          id: 'hello',
          command: 'printf ok',
        },
      ],
    }]),
  });

  assert.equal(result.validation.status, 'validated');
  assert.equal(result.validation.attempts.length, 1);
  assert.deepEqual(result.validation.attempts[0]?.output, ['ok']);
});

test('generateWorkflowDraft retries and returns failed_after_retries with diagnostics', async () => {
  const result = await generateWorkflowDraft({
    request: 'Generate a failing workflow.',
    validation: {
      enabled: true,
      maxRepairAttempts: 2,
    },
    ctx: createCtx([
      {
        name: 'broken-flow',
        steps: [
          {
            id: 'fail',
            command: 'cat missing-file.txt',
          },
        ],
      },
    ]),
  });

  assert.equal(result.validation.status, 'failed_after_retries');
  assert.equal(result.validation.attempts.length, 3);
  assert.match(result.validation.attempts.at(-1)?.cliOutput ?? '', /Workflow failed at step fail \[shell\]/);
  assert.equal(result.studio.url.startsWith('http'), true);
});
