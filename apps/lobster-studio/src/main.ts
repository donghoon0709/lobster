import {
  addArg,
  addChildTask,
  addEnv,
  addTask,
  createInitialEditorState,
  moveChildTask,
  moveTask,
  removeArg,
  removeChildTask,
  removeEnv,
  removeTask,
  setChildTaskConditionField,
  setChildTaskExecutionMode,
  setTaskConditionField,
  setTaskExecutionMode,
  setTaskKind,
  setWorkflowField,
  updateArg,
  updateChildTaskField,
  updateEnv,
  updateTaskField,
  type EditorState,
} from './editor-state.js';
import { parseWorkflowText, testWorkflowText } from './api.js';
import { importWorkflowToEditorState } from './import.js';
import { renderEditor } from './render.js';

type WritableFileStream = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

type StudioFileHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<WritableFileStream>;
};

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description?: string;
      accept?: Record<string, string[]>;
    }>;
  }) => Promise<StudioFileHandle[]>;
};

let state = createInitialEditorState();
let fileHandle: StudioFileHandle | null = null;

const mount = globalThis.document.querySelector<HTMLElement>('#app');
if (!mount) {
  throw new Error('App mount node not found');
}

function setState(nextState: EditorState) {
  state = nextState;
  rerender();
}

function withDirtyStatus(nextState: EditorState) {
  if (!nextState.hasFileBinding || !nextState.currentFileName) return nextState;
  return {
    ...nextState,
    fileStatus: `Edited ${nextState.currentFileName}. Save to overwrite the file.`,
  };
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

async function openWorkflowFile() {
  const pickerWindow = globalThis.window as FilePickerWindow;
  if (!pickerWindow.showOpenFilePicker) {
    setState(setWorkflowField(state, 'fileStatus', 'Open requires a browser that supports the File System Access API.'));
    return;
  }

  try {
    const [handle] = await pickerWindow.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: true,
      types: [{
        description: 'Lobster workflows',
        accept: {
          'application/json': ['.lobster'],
          'text/plain': ['.lobster'],
          'application/yaml': ['.lobster'],
        },
      }],
    });

    if (!handle) return;

    const file = await handle.getFile();
    const response = await parseWorkflowText(await file.text());
    if (!response.ok) {
      setState(setWorkflowField(
        state,
        'fileStatus',
        `Open failed: ${'error' in response ? response.error : 'Unable to parse the workflow.'}`,
      ));
      return;
    }

    fileHandle = handle;
    setState(importWorkflowToEditorState(response.workflow, {
      fileName: handle.name,
      hasFileBinding: true,
    }));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    setState(setWorkflowField(
      state,
      'fileStatus',
      `Open failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

async function saveWorkflowFile(text: string) {
  if (!fileHandle) {
    try {
      const fileName = state.currentFileName || 'workflow.lobster';
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = globalThis.document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      setState(setWorkflowField(state, 'fileStatus', `Downloaded ${fileName}.`));
    } catch (error) {
      setState(setWorkflowField(
        state,
        'fileStatus',
        `Save failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    return;
  }

  try {
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
    setState(setWorkflowField(state, 'fileStatus', `Saved ${fileHandle.name}.`));
  } catch (error) {
    setState(setWorkflowField(
      state,
      'fileStatus',
      `Save failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

async function runWorkflowTest(text: string) {
  setState({
    ...state,
    testStatus: 'running',
    testMessage: 'Running Lobster test...',
    testOutput: '',
  });

  try {
    const response = await testWorkflowText(text);
    if (!response.ok) {
      setState({
        ...state,
        testStatus: 'error',
        testMessage: 'error' in response ? response.error : 'Unknown test failure.',
        testOutput: '',
      });
      return;
    }

    const nextStatus = response.result.status === 'success'
      ? 'success'
      : response.result.status === 'unsupported-approval'
        ? 'unsupported'
        : 'error';

    setState({
      ...state,
      testStatus: nextStatus,
      testMessage: response.result.message,
      testOutput: response.result.cliOutput ?? '',
    });
  } catch (error) {
    setState({
      ...state,
      testStatus: 'error',
      testMessage: error instanceof Error ? error.message : String(error),
      testOutput: '',
    });
  }
}

function rerender() {
  renderEditor(mount, state, {
    onOpenFile() {
      void openWorkflowFile();
    },
    onSaveFile(_fileName, text) {
      void saveWorkflowFile(text);
    },
    onRunTest(text) {
      void runWorkflowTest(text);
    },
    onWorkflowFieldChange(field, value) {
      state = withDirtyStatus(setWorkflowField(state, field, value));
      rerender();
    },
    onAddArg() {
      state = withDirtyStatus(addArg(state));
      rerender();
    },
    onUpdateArg(id, field, value) {
      state = withDirtyStatus(updateArg(state, id, field, value));
      rerender();
    },
    onRemoveArg(id) {
      state = withDirtyStatus(removeArg(state, id));
      rerender();
    },
    onAddEnv() {
      state = withDirtyStatus(addEnv(state));
      rerender();
    },
    onUpdateEnv(id, field, value) {
      state = withDirtyStatus(updateEnv(state, id, field, value));
      rerender();
    },
    onRemoveEnv(id) {
      state = withDirtyStatus(removeEnv(state, id));
      rerender();
    },
    onAddTask() {
      state = withDirtyStatus(addTask(state));
      rerender();
    },
    onAddChildTask(index) {
      state = withDirtyStatus(addChildTask(state, index));
      rerender();
    },
    onRemoveTask(index) {
      state = withDirtyStatus(removeTask(state, index));
      rerender();
    },
    onRemoveChildTask(index, childIndex) {
      state = withDirtyStatus(removeChildTask(state, index, childIndex));
      rerender();
    },
    onMoveTask(index, direction) {
      state = withDirtyStatus(moveTask(state, index, direction));
      rerender();
    },
    onMoveChildTask(index, childIndex, direction) {
      state = withDirtyStatus(moveChildTask(state, index, childIndex, direction));
      rerender();
    },
    onTaskFieldChange(index, field, value) {
      state = withDirtyStatus(updateTaskField(state, index, field, value));
      rerender();
    },
    onChildTaskFieldChange(index, childIndex, field, value) {
      state = withDirtyStatus(updateChildTaskField(state, index, childIndex, field, value));
      rerender();
    },
    onTaskKindChange(index, value) {
      state = withDirtyStatus(setTaskKind(state, index, value));
      rerender();
    },
    onExecutionModeChange(index, value) {
      state = withDirtyStatus(setTaskExecutionMode(state, index, value));
      rerender();
    },
    onChildExecutionModeChange(index, childIndex, value) {
      state = withDirtyStatus(setChildTaskExecutionMode(state, index, childIndex, value));
      rerender();
    },
    onConditionFieldChange(index, value) {
      state = withDirtyStatus(setTaskConditionField(state, index, value));
      rerender();
    },
    onChildConditionFieldChange(index, childIndex, value) {
      state = withDirtyStatus(setChildTaskConditionField(state, index, childIndex, value));
      rerender();
    },
    onCopyExport(text) {
      void copyExport(text);
    },
  });
}
rerender();
