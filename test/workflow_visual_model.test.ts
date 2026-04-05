import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addTask,
  createInitialEditorState,
  moveTask,
  removeTask,
} from '../apps/lobster-studio/src/editor-state.js';

test('editor model can add and reorder tasks without losing ids', () => {
  let state = createInitialEditorState();
  state = addTask(addTask(state));

  state.tasks[0].id = 'fetch';
  state.tasks[1].id = 'confirm';
  state.tasks[2].id = 'finish';

  state = moveTask(state, 2, -1);

  assert.deepEqual(
    state.tasks.map((task) => task.id),
    ['fetch', 'finish', 'confirm'],
  );
});

test('editor model can remove a task and keep the remaining order', () => {
  let state = createInitialEditorState();
  state = addTask(addTask(state));

  state.tasks[0].id = 'fetch';
  state.tasks[1].id = 'confirm';
  state.tasks[2].id = 'finish';

  state = removeTask(state, 1);

  assert.deepEqual(
    state.tasks.map((task) => task.id),
    ['fetch', 'finish'],
  );
});
