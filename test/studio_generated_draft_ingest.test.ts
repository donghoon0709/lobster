import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGeneratedDraftHandoffUrl,
  createGeneratedDraftDescriptor,
  resolveGeneratedDraftHydration,
} from '../apps/lobster-studio/src/generated-draft.js';

test('generated draft handoff hydrates Studio editor state from a bounded descriptor URL', () => {
  const descriptor = createGeneratedDraftDescriptor({
    name: 'handoff-workflow',
    description: 'Prepared by MCP',
    args: {
      city: {
        default: 'Seoul',
        description: 'default city',
      },
    },
    env: {
      OPENCLAW_URL: 'http://127.0.0.1:18789',
    },
    steps: [
      {
        id: 'fetch',
        command: 'weather --json ${city}',
      },
      {
        id: 'approve',
        approval: 'Proceed?',
        stdin: '$fetch.json',
      },
      {
        id: 'summarize',
        pipeline: 'llm.invoke --prompt "Summarize the forecast"',
        stdin: '$fetch.json',
        condition: '$approve.approved',
      },
    ],
  });

  const handoffUrl = buildGeneratedDraftHandoffUrl('https://studio.example/apps/lobster-studio/', descriptor);
  const hydration = resolveGeneratedDraftHydration(handoffUrl);

  assert.equal(hydration.kind, 'loaded');
  assert.equal(hydration.source, 'query');
  assert.equal(hydration.state.name, 'handoff-workflow');
  assert.equal(hydration.state.description, 'Prepared by MCP');
  assert.equal(hydration.state.copyStatus, 'Loaded generated draft.');
  assert.equal(hydration.state.fileStatus, 'Loaded handoff-workflow.lobster without overwrite-save binding.');
  assert.equal(hydration.state.currentFileName, 'handoff-workflow.lobster');
  assert.equal(hydration.state.hasFileBinding, false);
  assert.equal(hydration.state.testStatus, 'idle');
  assert.equal(hydration.state.testMessage, 'Ready to test the current working copy.');
  assert.deepEqual(hydration.state.args, [
    {
      id: 'arg_1',
      key: 'city',
      defaultValue: 'Seoul',
      description: 'default city',
      rawDefaultValue: 'Seoul',
    },
  ]);
  assert.deepEqual(hydration.state.env, [
    {
      id: 'env_1',
      key: 'OPENCLAW_URL',
      value: 'http://127.0.0.1:18789',
    },
  ]);
  assert.deepEqual(
    hydration.state.tasks.map((task) => ({
      id: task.id,
      executionMode: task.executionMode,
      approvalPrompt: task.approvalPrompt,
      conditionField: task.conditionField,
      conditionText: task.conditionText,
      stdin: task.stdin,
    })),
    [
      {
        id: 'fetch',
        executionMode: 'command',
        approvalPrompt: '',
        conditionField: 'when',
        conditionText: '',
        stdin: '',
      },
      {
        id: 'approve',
        executionMode: 'approval-only',
        approvalPrompt: 'Proceed?',
        conditionField: 'when',
        conditionText: '',
        stdin: '$fetch.json',
      },
      {
        id: 'summarize',
        executionMode: 'pipeline',
        approvalPrompt: '',
        conditionField: 'condition',
        conditionText: '$approve.approved',
        stdin: '$fetch.json',
      },
    ],
  );
  assert.equal(hydration.state.tasks[1]?.passthrough.rawStdin, '$fetch.json');
  assert.equal(hydration.state.tasks[2]?.passthrough.rawConditionValue, '$approve.approved');
});

test('generated draft handoff also supports hash-based descriptor URLs', () => {
  const descriptor = createGeneratedDraftDescriptor({
    steps: [
      {
        id: 'fetch',
        run: 'node fetch.js',
      },
    ],
  });
  const encoded = new URL(buildGeneratedDraftHandoffUrl('https://studio.example/apps/lobster-studio/', descriptor)).searchParams.get('generatedDraft');
  const hydration = resolveGeneratedDraftHydration(`https://studio.example/apps/lobster-studio/#generatedDraft=${encoded}`);

  assert.equal(hydration.kind, 'loaded');
  assert.equal(hydration.source, 'hash');
  assert.equal(hydration.state.tasks[0]?.executionMode, 'run');
});
