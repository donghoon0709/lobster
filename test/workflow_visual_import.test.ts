import test from 'node:test';
import assert from 'node:assert/strict';

import { updateTaskField } from '../apps/lobster-studio/src/editor-state.js';
import { exportEditorState } from '../apps/lobster-studio/src/export.js';
import { importWorkflowToEditorState } from '../apps/lobster-studio/src/import.js';
import { parseWorkflowFileText } from '../src/workflows/parse.js';

test('imported .lobster workflows preserve hidden fields on export after visible edits', () => {
  const workflow = parseWorkflowFileText(`
name: imported-flow
cwd: /tmp/workflows
args:
  payload:
    default:
      city: Seoul
steps:
  - id: fetch
    command: node -e "process.stdout.write('ok')"
    cwd: /tmp/step-cwd
    env:
      API_URL: https://example.com
    stdin:
      city: Seoul
    when:
      ready: true
    approval:
      prompt: Review output
      items:
        - type: text
          text: preview
`, '.lobster');

  let state = importWorkflowToEditorState(workflow, {
    fileName: 'imported-flow.lobster',
    hasFileBinding: true,
  });

  state = updateTaskField(state, 0, 'command', 'node -e "process.stdout.write(\'updated\')"');
  const exported = exportEditorState(state).workflow;

  assert.equal(exported.cwd, '/tmp/workflows');
  assert.deepEqual(exported.args?.payload?.default, { city: 'Seoul' });
  assert.equal(exported.steps[0].cwd, '/tmp/step-cwd');
  assert.deepEqual(exported.steps[0].env, { API_URL: 'https://example.com' });
  assert.deepEqual(exported.steps[0].stdin, { city: 'Seoul' });
  assert.deepEqual(exported.steps[0].when, { ready: true });
  assert.deepEqual(exported.steps[0].approval, {
    prompt: 'Review output',
    items: [{ type: 'text', text: 'preview' }],
  });
  assert.equal(exported.steps[0].command, 'node -e "process.stdout.write(\'updated\')"');
});

test('yaml-content .lobster files import into Studio state', () => {
  const workflow = parseWorkflowFileText(`
name: yaml-flow
steps:
  - id: greet
    run: echo hello
`, '.lobster');

  const state = importWorkflowToEditorState(workflow, {
    fileName: 'yaml-flow.lobster',
    hasFileBinding: true,
  });

  assert.equal(state.name, 'yaml-flow');
  assert.equal(state.currentFileName, 'yaml-flow.lobster');
  assert.equal(state.tasks[0].executionMode, 'run');
  assert.equal(state.tasks[0].run, 'echo hello');
});
