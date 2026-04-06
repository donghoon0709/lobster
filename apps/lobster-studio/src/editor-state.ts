import type {
  SupportedConditionalField,
  SupportedExecutionMode,
  WorkflowApproval,
} from '../../../src/workflows/types.js';

export type ArgEntry = {
  id: string;
  key: string;
  defaultValue: string;
  description: string;
  rawDefaultValue?: unknown;
};

export type EnvEntry = {
  id: string;
  key: string;
  value: string;
};

export type EditorTaskPassthrough = {
  cwd?: string;
  env?: Record<string, string>;
  approvalScalar?: true | 'required';
  approvalObject?: Extract<WorkflowApproval, object>;
  rawStdin?: unknown;
  rawConditionValue?: unknown;
};

export type EditorTask = {
  id: string;
  executionMode: SupportedExecutionMode;
  run: string;
  command: string;
  pipeline: string;
  approvalPrompt: string;
  stdin: string;
  conditionField: SupportedConditionalField;
  conditionText: string;
  passthrough: EditorTaskPassthrough;
};

export type EditorState = {
  name: string;
  description: string;
  args: ArgEntry[];
  env: EnvEntry[];
  tasks: EditorTask[];
  copyStatus: string;
  fileStatus: string;
  currentFileName: string;
  hasFileBinding: boolean;
  testStatus: 'idle' | 'running' | 'success' | 'error' | 'unsupported';
  testMessage: string;
  passthrough: {
    cwd?: string;
  };
};

function nextIndex(prefix: string, values: Array<{ id: string }>) {
  let candidate = values.length + 1;
  const ids = new Set(values.map((value) => value.id));
  while (ids.has(`${prefix}${candidate}`)) candidate += 1;
  return candidate;
}

export function createTask(index = 1): EditorTask {
  return {
    id: `task_${index}`,
    executionMode: 'command',
    run: '',
    command: '',
    pipeline: '',
    approvalPrompt: '',
    stdin: '',
    conditionField: 'when',
    conditionText: '',
    passthrough: {},
  };
}

export function createInitialEditorState(): EditorState {
  return {
    name: 'sample-workflow',
    description: '',
    args: [],
    env: [],
    tasks: [createTask(1)],
    copyStatus: 'Ready to export.',
    fileStatus: 'Open an existing .lobster file or start a new draft.',
    currentFileName: '',
    hasFileBinding: false,
    testStatus: 'idle',
    testMessage: 'No test run yet.',
    passthrough: {},
  };
}

export function setWorkflowField(
  state: EditorState,
  field: keyof Pick<EditorState, 'name' | 'description' | 'copyStatus' | 'fileStatus' | 'currentFileName' | 'hasFileBinding' | 'testStatus' | 'testMessage'>,
  value: string | boolean,
): EditorState {
  return { ...state, [field]: value };
}

export function addArg(state: EditorState): EditorState {
  const id = `arg_${nextIndex('arg_', state.args)}`;
  return {
    ...state,
    args: [...state.args, { id, key: '', defaultValue: '', description: '' }],
  };
}

export function updateArg(state: EditorState, id: string, field: keyof Omit<ArgEntry, 'id'>, value: string): EditorState {
  return {
    ...state,
    args: state.args.map((entry) => {
      if (entry.id !== id) return entry;
      if (field === 'defaultValue') {
        return { ...entry, defaultValue: value, rawDefaultValue: undefined };
      }
      return { ...entry, [field]: value };
    }),
  };
}

export function removeArg(state: EditorState, id: string): EditorState {
  return {
    ...state,
    args: state.args.filter((entry) => entry.id !== id),
  };
}

export function addEnv(state: EditorState): EditorState {
  const id = `env_${nextIndex('env_', state.env)}`;
  return {
    ...state,
    env: [...state.env, { id, key: '', value: '' }],
  };
}

export function updateEnv(state: EditorState, id: string, field: keyof Omit<EnvEntry, 'id'>, value: string): EditorState {
  return {
    ...state,
    env: state.env.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)),
  };
}

export function removeEnv(state: EditorState, id: string): EditorState {
  return {
    ...state,
    env: state.env.filter((entry) => entry.id !== id),
  };
}

export function addTask(state: EditorState): EditorState {
  return {
    ...state,
    tasks: [...state.tasks, createTask(nextIndex('task_', state.tasks))],
  };
}

export function removeTask(state: EditorState, index: number): EditorState {
  if (state.tasks.length === 1) return state;
  return {
    ...state,
    tasks: state.tasks.filter((_, current) => current !== index),
  };
}

export function moveTask(state: EditorState, index: number, direction: -1 | 1): EditorState {
  const nextIndexValue = index + direction;
  if (nextIndexValue < 0 || nextIndexValue >= state.tasks.length) return state;
  const tasks = [...state.tasks];
  const [task] = tasks.splice(index, 1);
  tasks.splice(nextIndexValue, 0, task);
  return { ...state, tasks };
}

export function updateTaskField(
  state: EditorState,
  index: number,
  field: keyof EditorTask,
  value: string,
): EditorState {
  return {
    ...state,
    tasks: state.tasks.map((task, current) => {
      if (current !== index) return task;
      if (field === 'stdin') {
        return {
          ...task,
          stdin: value,
          passthrough: { ...task.passthrough, rawStdin: undefined },
        };
      }
      if (field === 'conditionText') {
        return {
          ...task,
          conditionText: value,
          passthrough: { ...task.passthrough, rawConditionValue: undefined },
        };
      }
      if (field === 'approvalPrompt') {
        return {
          ...task,
          approvalPrompt: value,
          passthrough: {
            ...task.passthrough,
            approvalObject: undefined,
            approvalScalar: undefined,
          },
        };
      }
      return { ...task, [field]: value };
    }),
  };
}

export function setTaskExecutionMode(
  state: EditorState,
  index: number,
  mode: SupportedExecutionMode,
): EditorState {
  return {
    ...state,
    tasks: state.tasks.map((task, current) => (current === index ? { ...task, executionMode: mode } : task)),
  };
}

export function setTaskConditionField(
  state: EditorState,
  index: number,
  field: SupportedConditionalField,
): EditorState {
  return {
    ...state,
    tasks: state.tasks.map((task, current) => (
      current === index
        ? { ...task, conditionField: field, passthrough: { ...task.passthrough, rawConditionValue: undefined } }
        : task
    )),
  };
}
