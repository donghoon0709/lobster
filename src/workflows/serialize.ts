import type {
  SupportedConditionalField,
  WorkflowFile,
  WorkflowStep,
} from './types.js';

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    output[key] = stripUndefined(entry);
  }
  return output;
}

function isApprovalStep(approval: WorkflowStep['approval']) {
  if (approval === undefined || approval === false || approval === null) return false;
  if (approval === true || approval === 'required') return true;
  if (typeof approval === 'string') return approval.trim().length > 0;
  if (typeof approval === 'object') return Object.keys(approval).length > 0;
  return false;
}

function executionCount(step: WorkflowStep) {
  return Number(typeof step.run === 'string')
    + Number(typeof step.command === 'string')
    + Number(typeof step.pipeline === 'string');
}

export function validateSupportedWorkflowFile(workflow: WorkflowFile) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error('Workflow file must be a JSON/YAML object');
  }

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new Error('Workflow file requires a non-empty steps array');
  }

  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error('Workflow step must be an object');
    }
    if (!step.id || typeof step.id !== 'string') {
      throw new Error('Workflow step requires an id');
    }
    if (seen.has(step.id)) {
      throw new Error(`Duplicate workflow step id: ${step.id}`);
    }
    seen.add(step.id);

    const count = executionCount(step);
    if (count === 0 && !isApprovalStep(step.approval)) {
      throw new Error(`Workflow step ${step.id} requires run, command, pipeline, or approval`);
    }
    if (count > 1) {
      throw new Error(`Workflow step ${step.id} can only define one of run, command, or pipeline`);
    }
    if (step.run !== undefined && typeof step.run !== 'string') {
      throw new Error(`Workflow step ${step.id} run must be a string`);
    }
    if (step.command !== undefined && typeof step.command !== 'string') {
      throw new Error(`Workflow step ${step.id} command must be a string`);
    }
    if (step.pipeline !== undefined && typeof step.pipeline !== 'string') {
      throw new Error(`Workflow step ${step.id} pipeline must be a string`);
    }
    if (step.when !== undefined && step.condition !== undefined) {
      throw new Error(`Workflow step ${step.id} cannot define both when and condition`);
    }
  }

  return workflow;
}

export function setConditionalField(
  step: WorkflowStep,
  field: SupportedConditionalField,
  value: unknown,
): WorkflowStep {
  const next: WorkflowStep = { ...step };
  delete next.when;
  delete next.condition;
  if (value !== undefined && value !== '') {
    next[field] = value;
  }
  return next;
}

export function serializeWorkflowFile(workflow: WorkflowFile) {
  validateSupportedWorkflowFile(workflow);
  return `${JSON.stringify(stripUndefined(workflow), null, 2)}\n`;
}
