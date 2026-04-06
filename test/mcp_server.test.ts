import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpHarness, skipOnServerLifecycleGap } from './helpers/mcp_harness.js';

test('mcp server initializes and lists generate_workflow_draft', async (t) => {
  try {
    const mcp = await createMcpHarness(t);
    if (!mcp) return;

    const initialized = await mcp.initialize();
    assert.equal(typeof initialized?.protocolVersion, 'string');
    assert.equal(typeof initialized?.serverInfo?.name, 'string');

    const tools = await mcp.listTools();
    const generateWorkflowDraft = tools.find((tool: any) => tool?.name === 'generate_workflow_draft');
    const editExistingWorkflow = tools.find((tool: any) => tool?.name === 'edit_existing_workflow');
    const applyExistingWorkflowEdit = tools.find((tool: any) => tool?.name === 'apply_existing_workflow_edit');

    assert.ok(generateWorkflowDraft, 'generate_workflow_draft tool should be exposed');
    assert.ok(editExistingWorkflow, 'edit_existing_workflow tool should be exposed');
    assert.ok(applyExistingWorkflowEdit, 'apply_existing_workflow_edit tool should be exposed');
    assert.equal(typeof generateWorkflowDraft.description, 'string');
    assert.ok(
      generateWorkflowDraft.inputSchema && typeof generateWorkflowDraft.inputSchema === 'object',
      'generate_workflow_draft should publish an input schema',
    );
    assert.ok(
      editExistingWorkflow.inputSchema && typeof editExistingWorkflow.inputSchema === 'object',
      'edit_existing_workflow should publish an input schema',
    );
    assert.ok(
      applyExistingWorkflowEdit.inputSchema && typeof applyExistingWorkflowEdit.inputSchema === 'object',
      'apply_existing_workflow_edit should publish an input schema',
    );
  } catch (error) {
    if (skipOnServerLifecycleGap(t, error)) return;
    throw error;
  }
});
