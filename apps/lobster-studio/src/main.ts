import {
  addArg,
  addEnv,
  addTask,
  createInitialEditorState,
  moveTask,
  removeArg,
  removeEnv,
  removeTask,
  setTaskConditionField,
  setTaskExecutionMode,
  setWorkflowField,
  updateArg,
  updateEnv,
  updateTaskField,
} from './editor-state.js';
import { renderEditor } from './render.js';

let state = createInitialEditorState();

const mount = document.querySelector<HTMLElement>('#app');
if (!mount) {
  throw new Error('App mount node not found');
}

async function copyExport(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      state = setWorkflowField(state, 'copyStatus', 'Copied to clipboard.');
    } else {
      state = setWorkflowField(state, 'copyStatus', 'Clipboard API unavailable in this browser.');
    }
  } catch (error) {
    state = setWorkflowField(
      state,
      'copyStatus',
      `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  rerender();
}

function rerender() {
  renderEditor(mount, state, {
    onWorkflowFieldChange(field, value) {
      state = setWorkflowField(state, field, value);
      rerender();
    },
    onAddArg() {
      state = addArg(state);
      rerender();
    },
    onUpdateArg(id, field, value) {
      state = updateArg(state, id, field, value);
      rerender();
    },
    onRemoveArg(id) {
      state = removeArg(state, id);
      rerender();
    },
    onAddEnv() {
      state = addEnv(state);
      rerender();
    },
    onUpdateEnv(id, field, value) {
      state = updateEnv(state, id, field, value);
      rerender();
    },
    onRemoveEnv(id) {
      state = removeEnv(state, id);
      rerender();
    },
    onAddTask() {
      state = addTask(state);
      rerender();
    },
    onRemoveTask(index) {
      state = removeTask(state, index);
      rerender();
    },
    onMoveTask(index, direction) {
      state = moveTask(state, index, direction);
      rerender();
    },
    onTaskFieldChange(index, field, value) {
      state = updateTaskField(state, index, field, value);
      rerender();
    },
    onExecutionModeChange(index, value) {
      state = setTaskExecutionMode(state, index, value);
      rerender();
    },
    onConditionFieldChange(index, value) {
      state = setTaskConditionField(state, index, value);
      rerender();
    },
    onCopyExport(text) {
      void copyExport(text);
    },
    onDownloadExport(fileName, text) {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      state = setWorkflowField(state, 'copyStatus', `Downloaded ${fileName}.`);
      rerender();
    },
  });
}

rerender();
