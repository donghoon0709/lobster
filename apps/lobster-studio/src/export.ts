import {
  serializeWorkflowFile,
  setConditionalField,
  validateSupportedWorkflowFile,
} from '../../../src/workflows/serialize.js';
import type {
  WorkflowArgDefinition,
  WorkflowExecutionStep,
  WorkflowFile,
  WorkflowForEachStep,
  WorkflowStep,
} from '../../../src/workflows/types.js';
import type { EditorState, EditorTask } from './editor-state.js';

function stringifyEditorValue(value: unknown) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function buildArgs(args: EditorState['args']) {
  const output: Record<string, WorkflowArgDefinition> = {};
  for (const entry of args) {
    const key = entry.key.trim();
    if (!key) continue;

    const rawDefault = entry.rawDefaultValue;
    const defaultValue = rawDefault !== undefined
      && entry.defaultValue === stringifyEditorValue(rawDefault)
      ? rawDefault
      : entry.defaultValue;

    output[key] = {
      default: defaultValue,
      description: entry.description.trim() || undefined,
    };
  }
  return Object.keys(output).length ? output : undefined;
}

function buildEnv(envEntries: EditorState['env']) {
  const output: Record<string, string> = {};
  for (const entry of envEntries) {
    const key = entry.key.trim();
    if (!key) continue;
    output[key] = entry.value;
  }
  return Object.keys(output).length ? output : undefined;
}

function sanitizeStepId(rawId: string, index: number) {
  const trimmed = rawId.trim();
  return trimmed || `task_${index + 1}`;
}

function buildLeafStep(
  task: EditorTask,
  index: number,
  {
    allowApproval,
  }: {
    allowApproval: boolean;
  },
): WorkflowExecutionStep {
  let step: WorkflowExecutionStep = {
    id: sanitizeStepId(task.id, index),
  };

  if (task.executionMode === 'run' && task.run.trim()) {
    step.run = task.run.trim();
  } else if (task.executionMode === 'command' && task.command.trim()) {
    step.command = task.command.trim();
  } else if (task.executionMode === 'pipeline' && task.pipeline.trim()) {
    step.pipeline = task.pipeline.trim();
  }

  if (allowApproval) {
    if (task.passthrough.approvalObject
      && task.approvalPrompt === stringifyEditorValue(task.passthrough.approvalObject.prompt)) {
      step.approval = task.passthrough.approvalObject;
    } else if (task.passthrough.approvalScalar && task.approvalPrompt.trim() === '') {
      step.approval = task.passthrough.approvalScalar;
    } else if (task.executionMode === 'approval-only') {
      step.approval = task.approvalPrompt.trim() || 'required';
    } else if (task.approvalPrompt.trim()) {
      step.approval = task.approvalPrompt.trim();
    }
  } else if (task.executionMode === 'approval-only' || task.approvalPrompt.trim()) {
    throw new Error(`Loop child step ${sanitizeStepId(task.id, index)} cannot define approval`);
  }

  if (task.passthrough.rawStdin !== undefined && task.stdin === stringifyEditorValue(task.passthrough.rawStdin)) {
    step.stdin = task.passthrough.rawStdin;
  } else if (task.stdin.trim()) {
    step.stdin = task.stdin.trim();
  }

  if (task.passthrough.rawConditionValue !== undefined
    && task.conditionText === stringifyEditorValue(task.passthrough.rawConditionValue)) {
    step = setConditionalField(step, task.conditionField, task.passthrough.rawConditionValue);
  } else {
    step = setConditionalField(step, task.conditionField, task.conditionText.trim());
  }

  if (task.passthrough.env && Object.keys(task.passthrough.env).length) {
    step.env = { ...task.passthrough.env };
  }
  if (task.passthrough.cwd) {
    step.cwd = task.passthrough.cwd;
  }

  return step;
}

function buildStep(task: EditorTask, index: number): WorkflowStep {
  if (task.kind === 'for-each') {
    if (!task.childTasks.length) {
      throw new Error(`Loop step ${sanitizeStepId(task.id, index)} requires at least one child task`);
    }
    let loopStep: WorkflowForEachStep = {
      id: sanitizeStepId(task.id, index),
      for_each: task.forEach.trim(),
      steps: task.childTasks.map((child, childIndex) => buildLeafStep(child, childIndex, { allowApproval: false })),
    };
    if (task.passthrough.rawConditionValue !== undefined
      && task.conditionText === stringifyEditorValue(task.passthrough.rawConditionValue)) {
      loopStep = setConditionalField(loopStep, task.conditionField, task.passthrough.rawConditionValue) as WorkflowForEachStep;
    } else {
      loopStep = setConditionalField(loopStep, task.conditionField, task.conditionText.trim()) as WorkflowForEachStep;
    }
    return loopStep;
  }

  return buildLeafStep(task, index, { allowApproval: true }) as WorkflowStep;
}

export function editorStateToWorkflowFile(state: EditorState): WorkflowFile {
  const workflow: WorkflowFile = {
    name: state.name.trim() || undefined,
    description: state.description.trim() || undefined,
    args: buildArgs(state.args),
    env: buildEnv(state.env),
    cwd: state.passthrough.cwd,
    steps: state.tasks.map((task, index) => buildStep(task, index)),
  };
  return validateSupportedWorkflowFile(workflow);
}

export function buildExportFileName(name: string) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'workflow'}.lobster`;
}

export function exportEditorState(state: EditorState) {
  const workflow = editorStateToWorkflowFile(state);
  return {
    workflow,
    fileName: state.currentFileName || buildExportFileName(state.name),
    text: serializeWorkflowFile(workflow),
  };
}
