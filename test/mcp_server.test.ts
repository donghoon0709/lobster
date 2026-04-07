import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpHarness, skipOnServerLifecycleGap } from './helpers/mcp_harness.js';

test('mcp server initializes and lists the generate/test/reference tool set', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;

    const initialized = await mcp.initialize();
    assert.equal(typeof initialized?.protocolVersion, 'string');
    assert.equal(typeof initialized?.serverInfo?.name, 'string');

    const tools = await mcp.listTools();
    const generateWorkflowDraft = tools.find((tool: any) => tool?.name === 'generate_workflow_draft');
    const testWorkflow = tools.find((tool: any) => tool?.name === 'test_workflow');
    const searchReferenceDocs = tools.find((tool: any) => tool?.name === 'search_reference_docs');
    const editExistingWorkflow = tools.find((tool: any) => tool?.name === 'edit_existing_workflow');
    const applyExistingWorkflowEdit = tools.find((tool: any) => tool?.name === 'apply_existing_workflow_edit');

    assert.ok(generateWorkflowDraft, 'generate_workflow_draft tool should be exposed');
    assert.ok(testWorkflow, 'test_workflow tool should be exposed');
    assert.ok(searchReferenceDocs, 'search_reference_docs tool should be exposed');
    assert.equal(editExistingWorkflow, undefined, 'edit_existing_workflow tool should not be exposed');
    assert.equal(applyExistingWorkflowEdit, undefined, 'apply_existing_workflow_edit tool should not be exposed');
    assert.equal(typeof generateWorkflowDraft.description, 'string');
    assert.ok(
      generateWorkflowDraft.inputSchema && typeof generateWorkflowDraft.inputSchema === 'object',
      'generate_workflow_draft should publish an input schema',
    );
    assert.ok(
      testWorkflow.inputSchema && typeof testWorkflow.inputSchema === 'object',
      'test_workflow should publish an input schema',
    );
    assert.ok(
      searchReferenceDocs.inputSchema && typeof searchReferenceDocs.inputSchema === 'object',
      'search_reference_docs should publish an input schema',
    );
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});
