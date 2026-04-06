import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeStudioTestEnvelope,
  parseStudioWorkflowText,
  runStudioWorkflowTest,
} from '../apps/lobster-studio/scripts/studio-api.mjs';

test('parseStudioWorkflowText accepts yaml-content .lobster workflows', async () => {
  const result = await parseStudioWorkflowText({
    text: `
name: parsed-flow
steps:
  - id: hello
    command: node -e "process.stdout.write('ok')"
`,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.workflow.name, 'parsed-flow');
    assert.equal(result.workflow.steps[0].id, 'hello');
  }
});

test('normalizeStudioTestEnvelope maps approval-needed runs to unsupported status', () => {
  const normalized = normalizeStudioTestEnvelope({
    ok: true,
    status: 'needs_approval',
    output: [],
    requiresApproval: {
      prompt: 'Continue?',
      items: [],
    },
  });

  assert.deepEqual(normalized, {
    status: 'unsupported-approval',
    message: 'Approval-required workflows are not supported in Lobster Studio tests yet.',
  });
});

test('runStudioWorkflowTest returns success for passing workflows and cleans temp files', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lobster-studio-api-root-'));
  const result = await runStudioWorkflowTest({
    text: `
name: pass-flow
steps:
  - id: hello
    command: node -e "process.stdout.write('ok')"
`,
    tempRoot,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.status, 'success');
  }

  assert.deepEqual(await readdir(tempRoot), []);
});

test('runStudioWorkflowTest returns error for failing workflows', async () => {
  const result = await runStudioWorkflowTest({
    text: `
name: fail-flow
steps:
  - id: fail
    command: node -e "process.stderr.write('boom'); process.exit(1)"
`,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.status, 'error');
    assert.match(result.result.message, /boom|exit/i);
  }
});

test('runStudioWorkflowTest returns unsupported-approval for approval workflows', async () => {
  const result = await runStudioWorkflowTest({
    text: `
name: approve-flow
steps:
  - id: approve
    approval: required
`,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.status, 'unsupported-approval');
  }
});
