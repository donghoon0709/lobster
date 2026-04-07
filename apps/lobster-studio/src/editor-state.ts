import type {
  SupportedConditionalField,
  SupportedExecutionMode,
  WorkflowApproval,
} from '../../../src/workflows/types.js';

export type EditorTaskKind = 'task' | 'for-each';

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
  kind: EditorTaskKind;
  executionMode: SupportedExecutionMode;
  run: string;
  command: string;
  pipeline: string;
  approvalPrompt: string;
  stdin: string;
  forEach: string;
  conditionField: SupportedConditionalField;
  conditionText: string;
  childTasks: EditorTask[];
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
  testOutput: string;
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
    kind: 'task',
    executionMode: 'command',
    run: '',
    command: '',
    pipeline: '',
    approvalPrompt: '',
    stdin: '',
    forEach: '',
    conditionField: 'when',
    conditionText: '',
    childTasks: [],
    passthrough: {},
  };
}

function cloneTask(task: EditorTask): EditorTask {
  return {
    ...task,
    passthrough: { ...task.passthrough },
    childTasks: task.childTasks.map(cloneTask),
  };
}

function updateTaskAtIndex(
  tasks: EditorTask[],
  index: number,
  updater: (task: EditorTask) => EditorTask,
) {
  return tasks.map((task, current) => (current === index ? updater(task) : task));
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
    testOutput: '',
    passthrough: {},
  };
}

export function setWorkflowField(
  state: EditorState,
  field: keyof Pick<EditorState, 'name' | 'description' | 'copyStatus' | 'fileStatus' | 'currentFileName' | 'hasFileBinding' | 'testStatus' | 'testMessage' | 'testOutput'>,
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

export function setTaskKind(state: EditorState, index: number, kind: EditorTaskKind): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => {
      if (task.kind === kind) return task;
      if (kind === 'for-each') {
        return {
          ...cloneTask(task),
          kind,
          forEach: task.forEach || '$task_1.stdout',
          childTasks: task.childTasks.length ? task.childTasks.map(cloneTask) : [createTask(1)],
        };
      }
      return {
        ...cloneTask(task),
        kind,
        childTasks: [],
      };
    }),
  };
}

export function addChildTask(state: EditorState, index: number): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => ({
      ...cloneTask(task),
      childTasks: [...task.childTasks, createTask(nextIndex('task_', task.childTasks))],
    })),
  };
}

export function removeChildTask(state: EditorState, index: number, childIndex: number): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => ({
      ...cloneTask(task),
      childTasks: task.childTasks.filter((_, current) => current !== childIndex),
    })),
  };
}

export function moveChildTask(state: EditorState, index: number, childIndex: number, direction: -1 | 1): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => {
      const nextIndexValue = childIndex + direction;
      if (nextIndexValue < 0 || nextIndexValue >= task.childTasks.length) return task;
      const childTasks = task.childTasks.map(cloneTask);
      const [child] = childTasks.splice(childIndex, 1);
      childTasks.splice(nextIndexValue, 0, child);
      return {
        ...cloneTask(task),
        childTasks,
      };
    }),
  };
}

function updateLeafTaskField(task: EditorTask, field: keyof EditorTask, value: string): EditorTask {
  if (field === 'stdin') {
    return {
      ...cloneTask(task),
      stdin: value,
      passthrough: { ...task.passthrough, rawStdin: undefined },
    };
  }
  if (field === 'conditionText') {
    return {
      ...cloneTask(task),
      conditionText: value,
      passthrough: { ...task.passthrough, rawConditionValue: undefined },
    };
  }
  if (field === 'approvalPrompt') {
    return {
      ...cloneTask(task),
      approvalPrompt: value,
      passthrough: {
        ...task.passthrough,
        approvalObject: undefined,
        approvalScalar: undefined,
      },
    };
  }
  return { ...cloneTask(task), [field]: value };
}

export function updateTaskField(
  state: EditorState,
  index: number,
  field: keyof EditorTask,
  value: string,
): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => updateLeafTaskField(task, field, value)),
  };
}

export function updateChildTaskField(
  state: EditorState,
  index: number,
  childIndex: number,
  field: keyof EditorTask,
  value: string,
): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => ({
      ...cloneTask(task),
      childTasks: updateTaskAtIndex(task.childTasks, childIndex, (child) => updateLeafTaskField(child, field, value)),
    })),
  };
}

export function setTaskExecutionMode(
  state: EditorState,
  index: number,
  mode: SupportedExecutionMode,
): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => ({ ...cloneTask(task), executionMode: mode })),
  };
}

export function setChildTaskExecutionMode(
  state: EditorState,
  index: number,
  childIndex: number,
  mode: SupportedExecutionMode,
): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => ({
      ...cloneTask(task),
      childTasks: updateTaskAtIndex(task.childTasks, childIndex, (child) => ({ ...cloneTask(child), executionMode: mode })),
    })),
  };
}

export function setTaskConditionField(
  state: EditorState,
  index: number,
  field: SupportedConditionalField,
): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => (
      { ...cloneTask(task), conditionField: field, passthrough: { ...task.passthrough, rawConditionValue: undefined } }
    )),
  };
}

export function setChildTaskConditionField(
  state: EditorState,
  index: number,
  childIndex: number,
  field: SupportedConditionalField,
): EditorState {
  return {
    ...state,
    tasks: updateTaskAtIndex(state.tasks, index, (task) => ({
      ...cloneTask(task),
      childTasks: updateTaskAtIndex(task.childTasks, childIndex, (child) => (
        { ...cloneTask(child), conditionField: field, passthrough: { ...child.passthrough, rawConditionValue: undefined } }
      )),
    })),
  };
}
