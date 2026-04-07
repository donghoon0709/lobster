import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { testWorkflow } from '../src/workflows/test_workflow.js';

async function withWorkflowFile(text: string, fn: (filePath: string) => Promise<void>) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-test-workflow-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, text, 'utf8');
  try {
    await fn(filePath);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

function createCtx(env: NodeJS.ProcessEnv = process.env) {
  return {
    cwd: process.cwd(),
    env,
    registry: null,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    llmAdapters: {},
  };
}

test('testWorkflow reports success for a passing workflow', async () => {
  await withWorkflowFile(
    'name: pass-flow\nsteps:\n  - id: hello\n    command: node -e "process.stdout.write(\'ok\')"\n',
    async (filePath) => {
      const result = await testWorkflow({ filePath, ctx: createCtx() });
      assert.equal(result.success, true);
      assert.equal(result.status, 'success');
      assert.equal(result.reachedFinalStep, true);
      assert.deepEqual(result.output, ['ok']);
      assert.equal(Array.isArray(result.verboseTrace), true);
      assert.equal(result.verboseTrace[0]?.stepId, 'hello');
      assert.match(result.cliOutput ?? '', /Workflow step summary:/);
      assert.match(result.cliOutput ?? '', /- hello \[shell\] succeeded/);
    },
  );
});

test('testWorkflow returns a missing_inputs repair plan for unresolved args', async () => {
  await withWorkflowFile(
    'name: arg-flow\nsteps:\n  - id: hello\n    command: printf ${name}\n',
    async (filePath) => {
      const result = await testWorkflow({ filePath, ctx: createCtx() });
      assert.equal(result.success, false);
      assert.equal(result.status, 'error');
      assert.equal(result.repairPlan?.classification, 'missing_inputs');
      assert.deepEqual(result.repairPlan?.missingArgs, ['name']);
      assert.match(result.repairPlan?.suggestedEditRequest ?? '', /name/);
    },
  );
});

test('testWorkflow returns a missing_inputs repair plan for missing environment variables', async () => {
  await withWorkflowFile(
    'name: env-flow\nsteps:\n  - id: hello\n    command: printf $MISSING_ENV\n',
    async (filePath) => {
      const env = { ...process.env };
      delete env.MISSING_ENV;
      const result = await testWorkflow({ filePath, ctx: createCtx(env) });
      assert.equal(result.success, false);
      assert.equal(result.repairPlan?.classification, 'missing_inputs');
      assert.deepEqual(result.repairPlan?.missingEnv, ['MISSING_ENV']);
    },
  );
});

test('testWorkflow returns runtime evidence and a repair plan for failing workflows', async () => {
  await withWorkflowFile(
    'name: fail-flow\nsteps:\n  - id: fail\n    command: node -e "process.stderr.write(\'boom\'); process.exit(1)"\n',
    async (filePath) => {
      const result = await testWorkflow({ filePath, ctx: createCtx() });
      assert.equal(result.success, false);
      assert.equal(result.status, 'error');
      assert.equal(result.repairPlan?.classification, 'runtime');
      assert.equal(Array.isArray(result.verboseTrace), true);
      assert.equal(result.verboseTrace[0]?.stepId, 'fail');
      assert.match(result.cliOutput ?? '', /Workflow step summary:/);
      assert.match(result.cliOutput ?? '', /Workflow failed at step fail \[shell\]/);
      assert.match(result.repairPlan?.summary ?? '', /boom|workflow command failed/i);
    },
  );
});

test('testWorkflow returns unsupported-approval with an approval repair plan', async () => {
  await withWorkflowFile(
    'name: approve-flow\nsteps:\n  - id: approve\n    approval: required\n',
    async (filePath) => {
      const result = await testWorkflow({ filePath, ctx: createCtx() });
      assert.equal(result.success, false);
      assert.equal(result.status, 'unsupported-approval');
      assert.equal(result.repairPlan?.classification, 'approval');
    },
  );
});

test('testWorkflow returns a parse repair plan for invalid workflows', async () => {
  await withWorkflowFile(
    'name: broken\nsteps:\n  - id: hello\n    command: [unterminated\n',
    async (filePath) => {
      const result = await testWorkflow({ filePath, ctx: createCtx() });
      assert.equal(result.success, false);
      assert.equal(result.repairPlan?.classification, 'parse');
      assert.match(result.message, /yaml|flow collection|flow sequence|unexpected/i);
    },
  );
});
