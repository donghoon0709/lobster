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

function renderIndent(depth: number) {
  return '  '.repeat(depth);
}

function renderKey(key: string) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key) ? key : JSON.stringify(key);
}

function isPlainScalarString(value: string) {
  return /^[A-Za-z0-9_./${}-]+$/u.test(value)
    && !/^(true|false|null|~|-?\d+(\.\d+)?)$/u.test(value);
}

function renderInlineValue(value: unknown) {
  if (typeof value === 'string') {
    return isPlainScalarString(value) ? value : JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return JSON.stringify(stripUndefined(value));
}

function pushNestedRecord(
  lines: string[],
  depth: number,
  key: string,
  record: Record<string, unknown> | undefined,
) {
  if (!record || Object.keys(record).length === 0) return;
  lines.push(`${renderIndent(depth)}${renderKey(key)}:`);
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (entryValue === undefined) continue;
    lines.push(`${renderIndent(depth + 1)}${renderKey(entryKey)}: ${renderInlineValue(entryValue)}`);
  }
}

function pushStepLines(lines: string[], step: WorkflowStep) {
  lines.push(`  - id: ${renderInlineValue(step.id)}`);
  if (step.run !== undefined) lines.push(`    run: ${renderInlineValue(step.run)}`);
  if (step.command !== undefined) lines.push(`    command: ${renderInlineValue(step.command)}`);
  if (step.pipeline !== undefined) lines.push(`    pipeline: ${renderInlineValue(step.pipeline)}`);
  pushNestedRecord(lines, 2, 'env', step.env);
  if (step.cwd !== undefined) lines.push(`    cwd: ${renderInlineValue(step.cwd)}`);
  if (step.stdin !== undefined) lines.push(`    stdin: ${renderInlineValue(step.stdin)}`);
  if (step.approval !== undefined) lines.push(`    approval: ${renderInlineValue(step.approval)}`);
  if (step.when !== undefined) lines.push(`    when: ${renderInlineValue(step.when)}`);
  if (step.condition !== undefined) lines.push(`    condition: ${renderInlineValue(step.condition)}`);
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
  const validated = validateSupportedWorkflowFile(workflow);
  const lines: string[] = [];

  if (validated.name !== undefined) lines.push(`name: ${renderInlineValue(validated.name)}`);
  if (validated.description !== undefined) lines.push(`description: ${renderInlineValue(validated.description)}`);
  if (validated.args && Object.keys(validated.args).length) {
    lines.push('args:');
    for (const [argName, definition] of Object.entries(validated.args)) {
      if (definition.default === undefined && definition.description === undefined) {
        lines.push(`  ${renderKey(argName)}: {}`);
        continue;
      }
      lines.push(`  ${renderKey(argName)}:`);
      if (definition.default !== undefined) lines.push(`    default: ${renderInlineValue(definition.default)}`);
      if (definition.description !== undefined) lines.push(`    description: ${renderInlineValue(definition.description)}`);
    }
  }
  pushNestedRecord(lines, 0, 'env', validated.env);
  if (validated.cwd !== undefined) lines.push(`cwd: ${renderInlineValue(validated.cwd)}`);
  lines.push('steps:');
  for (const step of validated.steps) {
    pushStepLines(lines, step);
  }

  return `${lines.join('\n')}\n`;
}
