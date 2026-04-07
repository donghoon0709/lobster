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

test('mcp tools/list exposes generate, test, and reference tools only', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const tools = await mcp.listTools();
    const names = tools.map((tool: { name: string }) => tool.name).sort();

    assert.deepEqual(names, ['generate_workflow_draft', 'search_reference_docs', 'test_workflow']);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('search_reference_docs returns command-reference matches for llm.invoke', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const result = await mcp.callTool('search_reference_docs', {
      query: 'llm.invoke',
      areas: ['commands'],
      maxResults: 3,
    });

    assert.equal(result.structuredContent?.kind, 'lobster.reference.search');
    assert.equal(result.structuredContent?.results?.length > 0, true);
    assert.equal(result.structuredContent?.results?.[0]?.area, 'commands');
    assert.match(result.structuredContent?.results?.[0]?.snippet ?? '', /llm\.invoke/i);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('generate_workflow_draft returns canonical .lobster text and Studio handoff without validation metadata', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const result = await mcp.callTool('generate_workflow_draft', defaultGenerateWorkflowArgs());
    const workflowText = extractWorkflowText(result);
    const handoff = extractStudioHandoff(result);

    await assertCanonicalWorkflowText(workflowText);
    assert.equal(handoff.url.startsWith('http'), true);
    assert.equal('validation' in (result.structuredContent ?? {}), false);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('generate_workflow_draft writes the requested file in one pass', async (t) => {
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
    assert.equal('validation' in (result.structuredContent ?? {}), false);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('removed edit/apply workflow tools return unknown-tool errors', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    await assert.rejects(
      () => mcp.callTool('edit_existing_workflow', { filePath: 'x.lobster', request: 'anything' }),
      /Unknown tool: edit_existing_workflow/i,
    );

    await assert.rejects(
      () => mcp.callTool('apply_existing_workflow_edit', { sessionId: 'anything' }),
      /Unknown tool: apply_existing_workflow_edit/i,
    );
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('test_workflow reports success for a passing workflow', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const filePath = path.join(os.tmpdir(), `lobster-mcp-test-pass-${Date.now()}.lobster`);
    await writeFile(filePath, 'name: pass\nsteps:\n  - id: hello\n    command: printf ok\n', 'utf8');
    t.after(async () => {
      await import('node:fs/promises').then(({ rm }) => rm(filePath, { force: true }));
    });

    const result = await mcp.callTool('test_workflow', { filePath });

    assert.equal(result.structuredContent?.success, true);
    assert.equal(result.structuredContent?.status, 'success');
    assert.equal(result.structuredContent?.reachedFinalStep, true);
    assert.deepEqual(result.structuredContent?.output, ['ok']);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('test_workflow returns a repair plan for missing workflow args', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const filePath = path.join(os.tmpdir(), `lobster-mcp-test-missing-${Date.now()}.lobster`);
    await writeFile(filePath, 'name: missing\nsteps:\n  - id: hello\n    command: printf ${name}\n', 'utf8');
    t.after(async () => {
      await import('node:fs/promises').then(({ rm }) => rm(filePath, { force: true }));
    });

    const result = await mcp.callTool('test_workflow', { filePath });

    assert.equal(result.structuredContent?.success, false);
    assert.equal(result.structuredContent?.repairPlan?.classification, 'missing_inputs');
    assert.deepEqual(result.structuredContent?.repairPlan?.missingArgs, ['name']);
    assert.match(result.structuredContent?.repairPlan?.suggestedEditRequest ?? '', /name/);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});

test('test_workflow returns runtime evidence and a repair plan for failing workflows', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;
    await mcp.initialize();

    const filePath = path.join(os.tmpdir(), `lobster-mcp-test-fail-${Date.now()}.lobster`);
    await writeFile(filePath, 'name: fail\nsteps:\n  - id: boom\n    command: cat missing-file.txt\n', 'utf8');
    t.after(async () => {
      await import('node:fs/promises').then(({ rm }) => rm(filePath, { force: true }));
    });

    const result = await mcp.callTool('test_workflow', { filePath });

    assert.equal(result.structuredContent?.success, false);
    assert.equal(result.structuredContent?.status, 'error');
    assert.equal(result.structuredContent?.repairPlan?.classification, 'runtime');
    assert.match(result.structuredContent?.cliOutput ?? '', /Workflow failed at step boom \[shell\]/);
    assert.ok(result.structuredContent?.repairPlan?.evidence?.trace);
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});
