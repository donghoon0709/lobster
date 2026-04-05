import {
  serializeWorkflowFile,
  setConditionalField,
  validateSupportedWorkflowFile,
} from '../../../src/workflows/serialize.js';
import type { WorkflowArgDefinition, WorkflowFile, WorkflowStep } from '../../../src/workflows/types.js';
import type { EditorState, EditorTask } from './editor-state.js';

function buildArgs(args: EditorState['args']) {
  const output: Record<string, WorkflowArgDefinition> = {};
  for (const entry of args) {
    const key = entry.key.trim();
    if (!key) continue;
    output[key] = {
      default: entry.defaultValue,
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

function buildStep(task: EditorTask, index: number): WorkflowStep {
  let step: WorkflowStep = {
    id: sanitizeStepId(task.id, index),
  };

  if (task.executionMode === 'run' && task.run.trim()) {
    step.run = task.run.trim();
  } else if (task.executionMode === 'command' && task.command.trim()) {
    step.command = task.command.trim();
  } else if (task.executionMode === 'pipeline' && task.pipeline.trim()) {
    step.pipeline = task.pipeline.trim();
  }

  if (task.executionMode === 'approval-only') {
    step.approval = task.approvalPrompt.trim() || 'required';
  } else if (task.approvalPrompt.trim()) {
    step.approval = task.approvalPrompt.trim();
  }

  if (task.stdin.trim()) {
    step.stdin = task.stdin.trim();
  }

  step = setConditionalField(step, task.conditionField, task.conditionText.trim());
  return step;
}

export function editorStateToWorkflowFile(state: EditorState): WorkflowFile {
  const workflow: WorkflowFile = {
    name: state.name.trim() || undefined,
    description: state.description.trim() || undefined,
    args: buildArgs(state.args),
    env: buildEnv(state.env),
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
    fileName: buildExportFileName(state.name),
    text: serializeWorkflowFile(workflow),
  };
}
