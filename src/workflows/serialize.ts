import type {
  SupportedConditionalField,
  WorkflowFile,
  WorkflowForEachStep,
  WorkflowLoopChildStep,
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

function isForEachStep(step: WorkflowStep): step is WorkflowForEachStep {
  return 'for_each' in step;
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

function pushConditionalLines(lines: string[], depth: number, step: { when?: unknown; condition?: unknown }) {
  if (step.when !== undefined) lines.push(`${renderIndent(depth)}when: ${renderInlineValue(step.when)}`);
  if (step.condition !== undefined) lines.push(`${renderIndent(depth)}condition: ${renderInlineValue(step.condition)}`);
}

function pushExecutionStepLines(lines: string[], step: WorkflowLoopChildStep, depth: number) {
  lines.push(`${renderIndent(depth)}- id: ${renderInlineValue(step.id)}`);
  if (step.run !== undefined) lines.push(`${renderIndent(depth + 1)}run: ${renderInlineValue(step.run)}`);
  if (step.command !== undefined) lines.push(`${renderIndent(depth + 1)}command: ${renderInlineValue(step.command)}`);
  if (step.pipeline !== undefined) lines.push(`${renderIndent(depth + 1)}pipeline: ${renderInlineValue(step.pipeline)}`);
  pushNestedRecord(lines, depth + 1, 'env', step.env);
  if (step.cwd !== undefined) lines.push(`${renderIndent(depth + 1)}cwd: ${renderInlineValue(step.cwd)}`);
  if (step.stdin !== undefined) lines.push(`${renderIndent(depth + 1)}stdin: ${renderInlineValue(step.stdin)}`);
  if (step.approval !== undefined) {
    lines.push(`${renderIndent(depth + 1)}approval: ${renderInlineValue(step.approval)}`);
  }
  pushConditionalLines(lines, depth + 1, step);
}

function pushStepLines(lines: string[], step: WorkflowStep, depth = 1) {
  if (isForEachStep(step)) {
    lines.push(`${renderIndent(depth)}- id: ${renderInlineValue(step.id)}`);
    lines.push(`${renderIndent(depth + 1)}for_each: ${renderInlineValue(step.for_each)}`);
    pushConditionalLines(lines, depth + 1, step);
    lines.push(`${renderIndent(depth + 1)}steps:`);
    for (const child of step.steps) {
      pushExecutionStepLines(lines, child, depth + 2);
    }
    return;
  }

  pushExecutionStepLines(lines, step, depth);
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
    validateStep(step, {
      parentId: null,
      seen,
      allowLoop: true,
      allowApproval: true,
    });
  }

  return workflow;
}

function validateStep(
  step: WorkflowStep | WorkflowLoopChildStep,
  {
    parentId,
    seen,
    allowLoop,
    allowApproval,
  }: {
    parentId: string | null;
    seen: Set<string>;
    allowLoop: boolean;
    allowApproval: boolean;
  },
) {
  if (!step.id || typeof step.id !== 'string') {
    throw new Error(parentId ? `Workflow step in ${parentId} requires an id` : 'Workflow step requires an id');
  }
  if (seen.has(step.id)) {
    throw new Error(parentId ? `Duplicate workflow step id in ${parentId}: ${step.id}` : `Duplicate workflow step id: ${step.id}`);
  }
  seen.add(step.id);

  if (step.when !== undefined && step.condition !== undefined) {
    throw new Error(`Workflow step ${step.id} cannot define both when and condition`);
  }

  if ('for_each' in step || 'steps' in step) {
    validateForEachStep(step as WorkflowForEachStep, { allowLoop });
    return;
  }

  validateExecutionStep(step, { allowApproval });
}

function validateExecutionStep(
  step: WorkflowLoopChildStep,
  { allowApproval }: { allowApproval: boolean },
) {
  const count = executionCount(step);
  const approval = 'approval' in step ? step.approval : undefined;

  if (!allowApproval && approval !== undefined) {
    throw new Error(`Workflow loop child step ${step.id} cannot define approval`);
  }
  if (count === 0 && !isApprovalStep(approval)) {
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
}

function validateForEachStep(
  step: WorkflowForEachStep,
  {
    allowLoop,
  }: {
    allowLoop: boolean;
  },
) {
  if (!allowLoop) {
    throw new Error(`Workflow loop child step ${step.id} cannot define nested for_each`);
  }
  if (typeof step.for_each !== 'string' || step.for_each.trim().length === 0) {
    throw new Error(`Workflow step ${step.id} for_each must be a non-empty string`);
  }
  if (!/^\$[A-Za-z0-9_-]+\.stdout$/u.test(step.for_each.trim())) {
    throw new Error(`Workflow step ${step.id} for_each must reference a previous step stdout like $step.stdout`);
  }
  if (!Array.isArray(step.steps) || step.steps.length === 0) {
    throw new Error(`Workflow step ${step.id} requires a non-empty steps array`);
  }
  if ('run' in step || 'command' in step || 'pipeline' in step || 'approval' in step || 'env' in step || 'cwd' in step || 'stdin' in step) {
    throw new Error(`Workflow step ${step.id} for_each steps cannot define run, command, pipeline, approval, env, cwd, or stdin`);
  }

  const childSeen = new Set<string>();
  for (const child of step.steps) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error(`Workflow step ${step.id} child step must be an object`);
    }
    validateStep(child, {
      parentId: step.id,
      seen: childSeen,
      allowLoop: false,
      allowApproval: false,
    });
  }
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
