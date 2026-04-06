import type {
  WorkflowApproval,
  WorkflowArgDefinition,
  WorkflowFile,
  WorkflowStep,
} from '../../../src/workflows/types.js';
import {
  createInitialEditorState,
  type ArgEntry,
  type EditorState,
  type EditorTask,
  type EditorTaskPassthrough,
} from './editor-state.js';

function stringifyEditorValue(value: unknown) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function importArgEntry(key: string, definition: WorkflowArgDefinition, index: number): ArgEntry {
  return {
    id: `arg_${index + 1}`,
    key,
    defaultValue: stringifyEditorValue(definition.default),
    description: typeof definition.description === 'string' ? definition.description : '',
    rawDefaultValue: definition.default,
  };
}

function importApproval(
  approval: WorkflowApproval | undefined,
  executionMode: EditorTask['executionMode'],
): { approvalPrompt: string; passthrough: Partial<EditorTaskPassthrough> } {
  if (approval === undefined || approval === false || approval === null) {
    return { approvalPrompt: '', passthrough: {} };
  }
  if (typeof approval === 'string') {
    if (approval === 'required') {
      return {
        approvalPrompt: '',
        passthrough: executionMode === 'approval-only' ? {} : { approvalScalar: 'required' },
      };
    }
    return { approvalPrompt: approval, passthrough: {} };
  }
  if (approval === true) {
    return {
      approvalPrompt: '',
      passthrough: executionMode === 'approval-only' ? {} : { approvalScalar: true },
    };
  }
  return {
    approvalPrompt: typeof approval.prompt === 'string' ? approval.prompt : '',
    passthrough: { approvalObject: structuredClone(approval) },
  };
}

function importTask(step: WorkflowStep, index: number): EditorTask {
  const executionMode = step.run !== undefined
    ? 'run'
    : step.command !== undefined
      ? 'command'
      : step.pipeline !== undefined
        ? 'pipeline'
        : 'approval-only';
  const { approvalPrompt, passthrough } = importApproval(step.approval, executionMode);
  const hasWhen = step.when !== undefined;
  return {
    id: step.id || `task_${index + 1}`,
    executionMode,
    run: typeof step.run === 'string' ? step.run : '',
    command: typeof step.command === 'string' ? step.command : '',
    pipeline: typeof step.pipeline === 'string' ? step.pipeline : '',
    approvalPrompt,
    stdin: stringifyEditorValue(step.stdin),
    conditionField: hasWhen ? 'when' : 'condition',
    conditionText: stringifyEditorValue(hasWhen ? step.when : step.condition),
    passthrough: {
      ...passthrough,
      cwd: step.cwd,
      env: step.env ? { ...step.env } : undefined,
      rawStdin: step.stdin,
      rawConditionValue: hasWhen ? step.when : step.condition,
    },
  };
}

export function importWorkflowFile(workflow: WorkflowFile, fileName = 'workflow.lobster'): EditorState {
  const base = createInitialEditorState();
  const fallbackName = fileName.replace(/\.lobster$/i, '') || 'workflow';
  return {
    ...base,
    name: typeof workflow.name === 'string' && workflow.name.trim() ? workflow.name : fallbackName,
    description: typeof workflow.description === 'string' ? workflow.description : '',
    args: workflow.args
      ? Object.entries(workflow.args).map(([key, definition], index) =>
        importArgEntry(key, definition ?? {}, index))
      : [],
    env: workflow.env
      ? Object.entries(workflow.env).map(([key, value], index) => ({
        id: `env_${index + 1}`,
        key,
        value,
      }))
      : [],
    tasks: workflow.steps.map((step, index) => importTask(step, index)),
    copyStatus: `Opened ${fileName}.`,
    fileStatus: `Opened ${fileName}. You can overwrite-save this file.`,
    currentFileName: fileName,
    hasFileBinding: true,
    testStatus: 'idle',
    testMessage: 'Ready to test the current working copy.',
    testOutput: '',
    passthrough: {
      cwd: workflow.cwd,
    },
  };
}

export function importWorkflowToEditorState(
  workflow: WorkflowFile,
  options: { fileName?: string; hasFileBinding?: boolean } = {},
) {
  const fileName = options.fileName || 'workflow.lobster';
  const nextState = importWorkflowFile(workflow, fileName);
  return {
    ...nextState,
    hasFileBinding: options.hasFileBinding ?? nextState.hasFileBinding,
    fileStatus: options.hasFileBinding === false
      ? `Loaded ${fileName} without overwrite-save binding.`
      : nextState.fileStatus,
  };
}
