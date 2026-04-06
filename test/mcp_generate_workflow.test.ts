import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
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
    assert.equal(result.structuredContent?.validation?.status, 'validation_skipped');
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
    assert.equal(result.structuredContent?.validation?.status, 'validation_skipped');
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('generate_workflow_draft can auto-validate a safe generated workflow', async (t) => {
  try {
    const previous = process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT;
    process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT = 'name: safe-flow\nsteps:\n  - id: hello\n    command: printf ok\n';
    t.after(() => {
      if (previous === undefined) {
        delete process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT;
      } else {
        process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT = previous;
      }
    });
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const result = await mcp.callTool('generate_workflow_draft', defaultGenerateWorkflowArgs());

    assert.equal(result.structuredContent?.validation?.status, 'validated');
    assert.deepEqual(result.structuredContent?.validation?.attempts?.[0]?.output, ['ok']);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('generate_workflow_draft returns failure diagnostics and Studio handoff after retry exhaustion', async (t) => {
  try {
    const previous = process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT;
    process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT = 'name: broken-flow\nsteps:\n  - id: fail\n    command: cat missing-file.txt\n';
    t.after(() => {
      if (previous === undefined) {
        delete process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT;
      } else {
        process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT = previous;
      }
    });
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const result = await mcp.callTool('generate_workflow_draft', defaultGenerateWorkflowArgs({ maxRepairAttempts: 2 }));
    const handoff = extractStudioHandoff(result);

    assert.equal(result.structuredContent?.validation?.status, 'failed_after_retries');
    assert.equal(result.structuredContent?.validation?.attempts?.length, 3);
    assert.match(result.structuredContent?.validation?.attempts?.[2]?.cliOutput ?? '', /Workflow failed at step fail \[shell\]/);
    assert.equal(handoff.url.startsWith('http'), true);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('edit_existing_workflow proposes edits without mutating the real file, and apply_existing_workflow_edit writes them back', async (t) => {
  try {
    const previous = process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT;
    process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT = 'name: edited\nsteps:\n  - id: hello\n    command: printf bye\n';
    t.after(() => {
      if (previous === undefined) {
        delete process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT;
      } else {
        process.env.LOBSTER_MCP_FAKE_WORKFLOW_TEXT = previous;
      }
    });
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const filePath = path.join(os.tmpdir(), `lobster-mcp-edit-${Date.now()}.lobster`);
    await writeFile(filePath, 'name: original\nsteps:\n  - id: hello\n    command: printf hi\n', 'utf8');
    t.after(async () => {
      await import('node:fs/promises').then(({ rm }) => rm(filePath, { force: true }));
    });

    const proposed = await mcp.callTool('edit_existing_workflow', {
      filePath,
      request: 'Change the command to print bye.',
      validate: false,
    });

    assert.match(await readFile(filePath, 'utf8'), /printf hi/);
    assert.match(proposed.structuredContent?.diff ?? '', /\+    command: "?printf bye"?/);
    assert.ok(proposed.structuredContent?.applySessionId);
    assert.ok(proposed.structuredContent?.studio?.url);

    const applied = await mcp.callTool('apply_existing_workflow_edit', {
      sessionId: proposed.structuredContent?.applySessionId,
    });

    assert.equal(applied.structuredContent?.applied, true);
    assert.match(await readFile(filePath, 'utf8'), /printf bye/);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});
