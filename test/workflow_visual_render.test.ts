/// <reference lib="dom" />

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialEditorState } from '../apps/lobster-studio/src/editor-state.js';
import { renderEditor } from '../apps/lobster-studio/src/render.js';

test('rendered task execution fields bind to command/run/pipeline task fields', () => {
  const state = createInitialEditorState();
  const root = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  } as unknown as HTMLElement;

  renderEditor(root, state, {
    onOpenFile() {},
    onSaveFile() {},
    onRunTest() {},
    onWorkflowFieldChange() {},
    onAddArg() {},
    onUpdateArg() {},
    onRemoveArg() {},
    onAddEnv() {},
    onUpdateEnv() {},
    onRemoveEnv() {},
    onAddTask() {},
    onRemoveTask() {},
    onMoveTask() {},
    onTaskFieldChange() {},
    onExecutionModeChange() {},
    onConditionFieldChange() {},
    onCopyExport() {},
  });

  assert.match(root.innerHTML, /data-task-field="command"/);
  assert.match(root.innerHTML, /data-task-field="run"/);
  assert.match(root.innerHTML, /data-task-field="pipeline"/);
  assert.doesNotMatch(root.innerHTML, /data-task-field="command-0"/);
});
