import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyExistingWorkflowEdit, editExistingWorkflow } from '../src/workflows/edit_existing.js';

function asStream(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function createLlmRegistry(responses: unknown[]) {
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

function createCtx(env: Record<string, string | undefined>, responses: unknown[]) {
  return {
    cwd: process.cwd(),
    env,
    registry: createLlmRegistry(responses),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

test('editExistingWorkflow proposes changes without mutating the original file and apply writes them back', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-edit-existing-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  const originalText = 'name: original\nsteps:\n  - id: hello\n    command: printf hi\n';
  await fsp.writeFile(filePath, originalText, 'utf8');
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
  };

  const editResult = await editExistingWorkflow({
    filePath,
    request: 'Change the command to print bye.',
    validation: { enabled: true },
    ctx: createCtx(env, [{
      name: 'edited',
      steps: [
        {
          id: 'hello',
          command: 'printf bye',
        },
      ],
    }]),
  });

  assert.equal(editResult.validation.status, 'validated');
  assert.match(editResult.diff, /-    command: printf hi/);
  assert.match(editResult.diff, /\+    command: "?printf bye"?/);
  assert.equal(await fsp.readFile(filePath, 'utf8'), originalText);

  const applied = await applyExistingWorkflowEdit({
    sessionId: editResult.applySessionId,
    ctx: { env, cwd: process.cwd() },
  });

  assert.equal(applied.applied, true);
  assert.equal(await fsp.readFile(filePath, 'utf8'), editResult.text);
});

test('applyExistingWorkflowEdit fails closed when the source file changed after propose', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-edit-existing-stale-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, 'name: original\nsteps:\n  - id: hello\n    command: printf hi\n', 'utf8');
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
  };

  const editResult = await editExistingWorkflow({
    filePath,
    request: 'Change the command.',
    validation: { enabled: false },
    ctx: createCtx(env, [{
      name: 'edited',
      steps: [
        {
          id: 'hello',
          command: 'printf bye',
        },
      ],
    }]),
  });

  await fsp.writeFile(filePath, 'name: changed\nsteps:\n  - id: hello\n    command: printf changed\n', 'utf8');

  await assert.rejects(
    () => applyExistingWorkflowEdit({
      sessionId: editResult.applySessionId,
      ctx: { env, cwd: process.cwd() },
    }),
    /Source workflow changed after propose\/edit/i,
  );
});
