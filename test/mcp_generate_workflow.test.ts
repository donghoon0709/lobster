import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertCanonicalWorkflowText,
  createMcpHarness,
  defaultGenerateWorkflowArgs,
  extractStudioHandoff,
  extractWorkflowText,
  skipOnServerLifecycleGap,
} from './helpers/mcp_harness.js';

test('generate_workflow_draft returns canonical .lobster text and Studio handoff when destination is omitted', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const result = await mcp.callTool('generate_workflow_draft', defaultGenerateWorkflowArgs());
    const workflowText = extractWorkflowText(result);
    const handoff = extractStudioHandoff(result);

    await assertCanonicalWorkflowText(workflowText);
    assert.equal(handoff.url.startsWith('http'), true);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('generate_workflow_draft writes the requested file and still returns a Studio handoff when destination is provided', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const destination = path.join(os.tmpdir(), `lobster-mcp-generated-${Date.now()}.lobster`);
    t.after(async () => {
      await import('node:fs/promises').then(({ rm }) => rm(destination, { force: true }));
    });

    const result = await mcp.callTool(
      'generate_workflow_draft',
      defaultGenerateWorkflowArgs({ destination }),
    );

    const handoff = extractStudioHandoff(result);
    const fileText = await readFile(destination, 'utf8');

    await assertCanonicalWorkflowText(fileText);
    assert.equal(handoff.url.startsWith('http'), true);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});
