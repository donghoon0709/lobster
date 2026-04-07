import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { parsePipeline } from '../parser.js';
import { runPipeline } from '../runtime.js';
import { encodeToken } from '../token.js';
import { deleteStateJson, readStateJson, writeStateJson } from '../state/store.js';
import { readLineFromStream } from '../read_line.js';
import { resolveInlineShellCommand } from '../shell.js';
import { normalizeSpawnEnv } from '../shell.js';
import { parseWorkflowFileText } from './parse.js';
import type {
  WorkflowExecutionStep,
  WorkflowFile,
  WorkflowForEachStep,
  WorkflowLoopChildStep,
  WorkflowStep,
} from './types.js';

export type { WorkflowApproval, WorkflowFile, WorkflowStep } from './types.js';

export type WorkflowStepResult = {
  id: string;
  stdout?: string;
  stderr?: string;
  json?: unknown;
  approved?: boolean;
  skipped?: boolean;
};

export type WorkflowStepTrace = {
  stepId: string;
  stepType: 'shell' | 'pipeline' | 'approval-only' | 'loop';
  status: 'succeeded' | 'failed' | 'skipped' | 'approved' | 'pending-approval';
  originalText?: string;
  resolvedText?: string;
  stdinPreview?: string;
  stdout?: string;
  stderr?: string;
};

export type WorkflowRunResult = {
  status: 'ok' | 'needs_approval' | 'cancelled';
  output: unknown[];
  trace?: WorkflowStepTrace[];
  requiresApproval?: {
    type: 'approval_request';
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
  };
};

type RunContext = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  mode: 'human' | 'tool' | 'sdk';
  cwd?: string;
  signal?: AbortSignal;
  registry?: {
    get: (name: string) => any;
  };
  llmAdapters?: Record<string, any>;
};

export type WorkflowResumePayload = {
  protocolVersion: 1;
  v: 1;
  kind: 'workflow-file';
  stateKey?: string;
  filePath?: string;
  resumeAtIndex?: number;
  steps?: Record<string, WorkflowStepResult>;
  args?: Record<string, unknown>;
  approvalStepId?: string;
};

type WorkflowResumeState = {
  filePath: string;
  resumeAtIndex: number;
  steps: Record<string, WorkflowStepResult>;
  args: Record<string, unknown>;
  approvalStepId?: string;
  createdAt: string;
};

type ResultScope = Record<string, WorkflowStepResult>;

type ExecutionScopes = {
  local: ResultScope;
  outer?: ResultScope;
};

type StepExecutionContext = {
  filePath: string;
  workflow: WorkflowFile;
  args: Record<string, unknown>;
  ctx: RunContext;
  topLevelResults: ResultScope;
  scopes: ExecutionScopes;
  trace: WorkflowStepTrace[];
  implicitStdin?: unknown;
  loopContext?: {
    loopStepId: string;
    iterationIndex: number;
  };
};

function isForEachStep(step: WorkflowStep | WorkflowLoopChildStep): step is WorkflowForEachStep {
  return 'for_each' in step;
}

export class WorkflowExecutionError extends Error {
  readonly filePath: string;
  readonly stepId: string;
  readonly stepType: WorkflowStepTrace['stepType'];
  readonly originalText?: string;
  readonly resolvedText?: string;
  readonly stdinPreview?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly trace: WorkflowStepTrace[];

  constructor({
    message,
    filePath,
    stepId,
    stepType,
    originalText,
    resolvedText,
    stdinPreview,
    stdout,
    stderr,
    trace,
  }: {
    message: string;
    filePath: string;
    stepId: string;
    stepType: WorkflowStepTrace['stepType'];
    originalText?: string;
    resolvedText?: string;
    stdinPreview?: string;
    stdout?: string;
    stderr?: string;
    trace: WorkflowStepTrace[];
  }) {
    super(message);
    this.name = 'WorkflowExecutionError';
    this.filePath = filePath;
    this.stepId = stepId;
    this.stepType = stepType;
    this.originalText = originalText;
    this.resolvedText = resolvedText;
    this.stdinPreview = stdinPreview;
    this.stdout = stdout;
    this.stderr = stderr;
    this.trace = trace;
  }
}

class WorkflowCommandError extends Error {
  readonly code: number | null;
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;

  constructor({
    code,
    command,
    stdout,
    stderr,
  }: {
    code: number | null;
    command: string;
    stdout: string;
    stderr: string;
  }) {
    super(`workflow command failed (${code}): ${stderr.trim() || stdout.trim() || command}`);
    this.name = 'WorkflowCommandError';
    this.code = code;
    this.command = command;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function loadWorkflowFile(filePath: string): Promise<WorkflowFile> {
  const text = await fsp.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  return parseWorkflowFileText(text, ext);
}

export function resolveWorkflowArgs(
  argDefs: WorkflowFile['args'],
  provided: Record<string, unknown> | undefined,
) {
  const resolved: Record<string, unknown> = {};
  if (argDefs) {
    for (const [key, def] of Object.entries(argDefs)) {
      if (def && typeof def === 'object' && 'default' in def) {
        resolved[key] = def.default;
      }
    }
  }
  if (provided) {
    for (const [key, value] of Object.entries(provided)) {
      resolved[key] = value;
    }
  }
  return resolved;
}

export async function runWorkflowFile({
  filePath,
  args,
  ctx,
  resume,
  approved,
}: {
  filePath?: string;
  args?: Record<string, unknown>;
  ctx: RunContext;
  resume?: WorkflowResumePayload;
  approved?: boolean;
}): Promise<WorkflowRunResult> {
  const consumedResumeStateKey = resume?.stateKey && typeof resume.stateKey === 'string'
    ? resume.stateKey
    : null;
  const resumeState = resume?.stateKey
    ? await loadWorkflowResumeState(ctx.env, resume.stateKey)
    : resume ?? null;
  const resolvedFilePath = filePath ?? resumeState?.filePath;
  if (!resolvedFilePath) {
    throw new Error('Workflow file path required');
  }
  const workflow = await loadWorkflowFile(resolvedFilePath);
  const resolvedArgs = resolveWorkflowArgs(workflow.args, args ?? resumeState?.args);
  const steps = workflow.steps;
  const results: Record<string, WorkflowStepResult> = resumeState?.steps
    ? cloneResults(resumeState.steps)
    : {};
  const trace: WorkflowStepTrace[] = [];
  const startIndex = resumeState?.resumeAtIndex ?? 0;

  if (resumeState?.approvalStepId && approved === false) {
    if (consumedResumeStateKey) {
      await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
    }
    return { status: 'cancelled', output: [] };
  }

  if (resumeState?.approvalStepId && typeof approved === 'boolean') {
    const previous = results[resumeState.approvalStepId] ?? { id: resumeState.approvalStepId };
    previous.approved = approved;
    results[resumeState.approvalStepId] = previous;
  }

  let lastStepId: string | null = findLastCompletedStepId(steps, results);
  for (let idx = startIndex; idx < steps.length; idx++) {
    const step = steps[idx];
    const result = await executeTopLevelStep(step, {
      filePath: resolvedFilePath,
      workflow,
      args: resolvedArgs,
      ctx,
      topLevelResults: results,
      scopes: { local: results },
      trace,
    });
    results[step.id] = result;
    lastStepId = step.id;

    if (isExecutionStep(step) && isApprovalStep(step.approval)) {
      const approval = extractApprovalRequest(step, results[step.id]);

      if (ctx.mode === 'tool' || !isInteractive(ctx.stdin)) {
        trace[trace.length - 1].status = 'pending-approval';
        const stateKey = await saveWorkflowResumeState(ctx.env, {
          filePath: resolvedFilePath,
          resumeAtIndex: idx + 1,
          steps: results,
          args: resolvedArgs,
          approvalStepId: step.id,
          createdAt: new Date().toISOString(),
        });

        if (consumedResumeStateKey && consumedResumeStateKey !== stateKey) {
          await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
        }

        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          kind: 'workflow-file',
          stateKey,
        } satisfies WorkflowResumePayload);

        return {
          status: 'needs_approval',
          output: [],
          trace,
          requiresApproval: {
            ...approval,
            resumeToken,
          },
        };
      }

      ctx.stdout.write(`${approval.prompt} [y/N] `);
      const answer = await readLineFromStream(ctx.stdin, {
        timeoutMs: parseApprovalTimeoutMs(ctx.env),
      });
      if (!/^y(es)?$/i.test(String(answer).trim())) {
        throw new Error('Not approved');
      }
      results[step.id].approved = true;
      trace[trace.length - 1].status = 'approved';
    }
  }

  const output = lastStepId ? toOutputItems(results[lastStepId]) : [];
  if (consumedResumeStateKey) {
    await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
  }
  return { status: 'ok', output, trace };
}

function isExecutionStep(step: WorkflowStep | WorkflowLoopChildStep): step is WorkflowExecutionStep {
  return !isForEachStep(step);
}

async function executeTopLevelStep(
  step: WorkflowStep,
  executionContext: StepExecutionContext,
): Promise<WorkflowStepResult> {
  if (isForEachStep(step)) {
    return executeForEachStep(step, executionContext);
  }
  return executeExecutionStep(step, executionContext);
}

async function executeExecutionStep(
  step: WorkflowExecutionStep | WorkflowLoopChildStep,
  {
    filePath,
    workflow,
    args,
    ctx,
    scopes,
    trace,
    implicitStdin,
    loopContext,
  }: StepExecutionContext,
): Promise<WorkflowStepResult> {
  const execution = getStepExecution(step);
  const stepType = getTraceStepType(step, execution);
  const traceStepId = buildTraceStepId(step.id, loopContext);

  if (!evaluateCondition(step.when ?? step.condition, scopes)) {
    const skipped = { id: step.id, skipped: true } satisfies WorkflowStepResult;
    scopes.local[step.id] = skipped;
    trace.push({
      stepId: traceStepId,
      stepType,
      status: 'skipped',
      originalText: execution.kind === 'none' ? undefined : execution.value,
    });
    return skipped;
  }

  const env = mergeEnv(ctx.env, workflow.env, step.env, args, scopes);
  const cwd = resolveCwd(step.cwd ?? workflow.cwd, args) ?? ctx.cwd;
  const resolvedStdin = resolveStepInput(step.stdin, {
    args,
    scopes,
    implicitValue: implicitStdin,
  });
  const stdinPreview = buildStdinPreview(execution.kind === 'shell' ? encodeShellInput(resolvedStdin) : resolvedStdin);

  try {
    let result: WorkflowStepResult;
    if (execution.kind === 'shell') {
      const command = resolveTemplate(execution.value, args, scopes);
      const shellStdin = encodeShellInput(resolvedStdin);
      const { stdout, stderr } = await runShellCommand({ command, stdin: shellStdin, env, cwd, signal: ctx.signal });
      result = { id: step.id, stdout, stderr, json: parseJson(stdout) };
      trace.push({
        stepId: traceStepId,
        stepType,
        status: 'succeeded',
        originalText: execution.value,
        resolvedText: command,
        stdinPreview,
        stdout,
        stderr,
      });
    } else if (execution.kind === 'pipeline') {
      if (!ctx.registry) {
        throw new Error(`Workflow step ${step.id} requires a command registry for pipeline execution`);
      }
      const pipelineText = resolveTemplate(execution.value, args, scopes);
      result = await runPipelineStep({
        stepId: traceStepId,
        pipelineText,
        inputValue: resolvedStdin,
        ctx,
        env,
        cwd,
      });
      result.id = step.id;
      trace.push({
        stepId: traceStepId,
        stepType,
        status: 'succeeded',
        originalText: execution.value,
        resolvedText: pipelineText,
        stdinPreview,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } else {
      result = createSyntheticStepResult(step.id, resolvedStdin);
      trace.push({
        stepId: traceStepId,
        stepType,
        status: 'succeeded',
        stdinPreview,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    scopes.local[step.id] = result;
    return result;
  } catch (error) {
    const stdout = error instanceof WorkflowCommandError ? error.stdout : undefined;
    const stderr = error instanceof WorkflowCommandError
      ? error.stderr
      : error instanceof Error
        ? error.message
        : String(error);
    const originalText = execution.kind === 'none' ? undefined : execution.value;
    const resolvedText = originalText ? resolveTemplate(originalText, args, scopes) : undefined;
    trace.push({
      stepId: traceStepId,
      stepType,
      status: 'failed',
      originalText,
      resolvedText,
      stdinPreview,
      stdout,
      stderr,
    });
    throw new WorkflowExecutionError({
      message: error instanceof Error ? error.message : String(error),
      filePath,
      stepId: loopContext?.loopStepId ?? step.id,
      stepType: loopContext ? 'loop' : stepType,
      originalText,
      resolvedText,
      stdinPreview,
      stdout,
      stderr,
      trace,
    });
  }
}

async function executeForEachStep(
  step: WorkflowForEachStep,
  {
    filePath,
    workflow,
    args,
    ctx,
    topLevelResults,
    scopes,
    trace,
  }: StepExecutionContext,
): Promise<WorkflowStepResult> {
  if (!evaluateCondition(step.when ?? step.condition, scopes)) {
    const skipped = { id: step.id, skipped: true } satisfies WorkflowStepResult;
    scopes.local[step.id] = skipped;
    trace.push({
      stepId: step.id,
      stepType: 'loop',
      status: 'skipped',
      originalText: step.for_each,
    });
    return skipped;
  }

  const sourceValue = resolveLoopSource(step.for_each, args, scopes);
  if (!Array.isArray(sourceValue)) {
    const description = describeValueForError(sourceValue);
    const message = `Workflow step ${step.id} for_each source must resolve to a JSON array, got ${description}`;
    trace.push({
      stepId: step.id,
      stepType: 'loop',
      status: 'failed',
      originalText: step.for_each,
      stderr: message,
    });
    throw new WorkflowExecutionError({
      message,
      filePath,
      stepId: step.id,
      stepType: 'loop',
      originalText: step.for_each,
      stderr: message,
      trace,
    });
  }

  const aggregate: unknown[] = [];
  for (let idx = 0; idx < sourceValue.length; idx++) {
    const item = sourceValue[idx];
    const childResults: ResultScope = {};
    for (let childIndex = 0; childIndex < step.steps.length; childIndex++) {
      const child = step.steps[childIndex];
      try {
        await executeExecutionStep(child, {
          filePath,
          workflow,
          args,
          ctx,
          topLevelResults,
          scopes: {
            local: childResults,
            outer: topLevelResults,
          },
          trace,
          implicitStdin: childIndex === 0 ? item : undefined,
          loopContext: {
            loopStepId: step.id,
            iterationIndex: idx,
          },
        });
      } catch (error) {
        if (error instanceof WorkflowExecutionError) {
          const message = `Workflow step ${step.id} failed in iteration ${idx + 1} at child step ${child.id}: ${error.message}`;
          throw new WorkflowExecutionError({
            message,
            filePath,
            stepId: step.id,
            stepType: 'loop',
            originalText: step.for_each,
            stderr: message,
            trace,
          });
        }
        throw error;
      }
    }
    const lastChild = childResults[step.steps[step.steps.length - 1].id];
    aggregate.push(extractAggregateValue(lastChild));
  }

  const result = {
    id: step.id,
    stdout: JSON.stringify(aggregate),
    stderr: '',
    json: aggregate,
  } satisfies WorkflowStepResult;
  trace.push({
    stepId: step.id,
    stepType: 'loop',
    status: 'succeeded',
    originalText: step.for_each,
    resolvedText: JSON.stringify(sourceValue),
    stdout: result.stdout,
    stderr: result.stderr,
  });
  scopes.local[step.id] = result;
  return result;
}

export function decodeWorkflowResumePayload(payload: unknown): WorkflowResumePayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Partial<WorkflowResumePayload>;
  if (data.kind !== 'workflow-file') return null;
  if (data.protocolVersion !== 1 || data.v !== 1) throw new Error('Unsupported token version');
  if (data.stateKey && typeof data.stateKey === 'string') {
    return data as WorkflowResumePayload;
  }
  if (!data.filePath || typeof data.filePath !== 'string') throw new Error('Invalid workflow token');
  if (typeof data.resumeAtIndex !== 'number') throw new Error('Invalid workflow token');
  if (!data.steps || typeof data.steps !== 'object') throw new Error('Invalid workflow token');
  if (!data.args || typeof data.args !== 'object') throw new Error('Invalid workflow token');
  return data as WorkflowResumePayload;
}

async function saveWorkflowResumeState(env: Record<string, string | undefined>, state: WorkflowResumeState) {
  const stateKey = `workflow_resume_${randomUUID()}`;
  await writeStateJson({ env, key: stateKey, value: state });
  return stateKey;
}

async function loadWorkflowResumeState(env: Record<string, string | undefined>, stateKey: string) {
  const stored = await readStateJson({ env, key: stateKey });
  if (!stored || typeof stored !== 'object') {
    throw new Error('Workflow resume state not found');
  }
  const data = stored as Partial<WorkflowResumeState>;
  if (!data.filePath || typeof data.filePath !== 'string') throw new Error('Invalid workflow resume state');
  if (typeof data.resumeAtIndex !== 'number') throw new Error('Invalid workflow resume state');
  if (!data.steps || typeof data.steps !== 'object') throw new Error('Invalid workflow resume state');
  if (!data.args || typeof data.args !== 'object') throw new Error('Invalid workflow resume state');
  return data as WorkflowResumeState;
}

function mergeEnv(
  base: Record<string, string | undefined>,
  workflowEnv: WorkflowFile['env'],
  stepEnv: WorkflowExecutionStep['env'],
  args: Record<string, unknown>,
  scopes: ExecutionScopes,
) {
  const env = { ...base } as Record<string, string | undefined>;

  // Expose resolved args as env vars so shell commands can safely reference them
  // without embedding raw values into the command string.
  // Example: $LOBSTER_ARG_TEXT
  env.LOBSTER_ARGS_JSON = JSON.stringify(args ?? {});
  for (const [key, value] of Object.entries(args ?? {})) {
    const normalized = normalizeArgEnvKey(key);
    if (!normalized) continue;
    env[`LOBSTER_ARG_${normalized}`] = String(value);
  }

  const apply = (source?: Record<string, string>) => {
    if (!source) return;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        env[key] = resolveTemplate(value, args, scopes);
      }
    }
  };

  // Allow explicit env blocks to override injected defaults.
  apply(workflowEnv);
  apply(stepEnv);
  return env;
}

function normalizeArgEnvKey(key: string): string | null {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return null;
  // Keep it predictable for shells: uppercase and [A-Z0-9_]
  const up = trimmed.toUpperCase();
  const normalized = up.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || null;
}

function resolveCwd(cwd: string | undefined, args: Record<string, unknown>) {
  if (!cwd) return undefined;
  return resolveArgsTemplate(cwd, args);
}

function resolveStepInput(
  stdin: unknown,
  {
    args,
    scopes,
    implicitValue,
  }: {
    args: Record<string, unknown>;
    scopes: ExecutionScopes;
    implicitValue?: unknown;
  },
) {
  if (stdin === undefined) {
    return implicitValue ?? null;
  }
  if (stdin === null) return null;
  if (typeof stdin === 'string') {
    const ref = parseStepRef(stdin.trim());
    if (ref) return getStepRefValue(ref, scopes, true);
    return resolveTemplate(stdin, args, scopes);
  }
  return stdin;
}

function resolveTemplate(
  input: string,
  args: Record<string, unknown>,
  scopes: ExecutionScopes,
) {
  const withArgs = resolveArgsTemplate(input, args);
  return resolveStepRefs(withArgs, scopes);
}

function resolveArgsTemplate(input: string, args: Record<string, unknown>) {
  return input.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (key in args) return String(args[key]);
    return match;
  });
}

function findStepResult(id: string, scopes: ExecutionScopes) {
  if (id in scopes.local) {
    return scopes.local[id];
  }
  if (scopes.outer && id in scopes.outer) {
    return scopes.outer[id];
  }
  return undefined;
}

function resolveStepRefs(input: string, scopes: ExecutionScopes) {
  return input.replace(/\$([A-Za-z0-9_-]+)\.(stdout|json|approved)/g, (match, id, field) => {
    const step = findStepResult(id, scopes);
    if (!step) return match;
    if (field === 'stdout') return step.stdout ?? '';
    if (field === 'json') return step.json !== undefined ? JSON.stringify(step.json) : '';
    if (field === 'approved') return step.approved === true ? 'true' : 'false';
    return match;
  });
}

function parseStepRef(value: string) {
  const match = value.match(/^\$([A-Za-z0-9_-]+)\.(stdout|json)$/);
  if (!match) return null;
  return { id: match[1], field: match[2] as 'stdout' | 'json' };
}

function getStepRefValue(
  ref: { id: string; field: 'stdout' | 'json' },
  scopes: ExecutionScopes,
  strict: boolean,
) {
  const step = findStepResult(ref.id, scopes);
  if (!step) {
    if (strict) throw new Error(`Unknown step reference: ${ref.id}.${ref.field}`);
    return '';
  }
  if (ref.field === 'stdout') return step.stdout ?? '';
  return step.json;
}

function evaluateCondition(
  condition: unknown,
  scopes: ExecutionScopes,
) {
  if (condition === undefined || condition === null) return true;
  if (typeof condition === 'boolean') return condition;
  if (typeof condition !== 'string') throw new Error('Unsupported condition type');

  const trimmed = condition.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  const match = trimmed.match(/^\$([A-Za-z0-9_-]+)\.(approved|skipped)$/);
  if (!match) throw new Error(`Unsupported condition: ${condition}`);

  const step = findStepResult(match[1], scopes);
  if (!step) return false;

  return match[2] === 'approved' ? step.approved === true : step.skipped === true;
}

function resolveLoopSource(
  source: string,
  args: Record<string, unknown>,
  scopes: ExecutionScopes,
) {
  const ref = parseStepRef(source.trim());
  const value = ref
    ? getStepRefValue(ref, scopes, true)
    : resolveTemplate(source, args, scopes);
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return parseJson(value);
  }
  return value;
}

function extractAggregateValue(result: WorkflowStepResult | undefined) {
  if (!result) return null;
  if (result.json !== undefined) return result.json;
  if (result.stdout !== undefined) return result.stdout;
  if (result.approved !== undefined) return result.approved;
  if (result.skipped) return null;
  return null;
}

function describeValueForError(value: unknown) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value;
}

function buildTraceStepId(stepId: string, loopContext?: { loopStepId: string; iterationIndex: number }) {
  if (!loopContext) return stepId;
  return `${loopContext.loopStepId}[${loopContext.iterationIndex + 1}].${stepId}`;
}

function isApprovalStep(approval: WorkflowStep['approval']) {
  if (approval === true) return true;
  if (typeof approval === 'string' && approval.trim().length > 0) return true;
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) return true;
  return false;
}

function extractApprovalRequest(step: WorkflowStep, result: WorkflowStepResult) {
  const approvalConfig = normalizeApprovalConfig(step.approval);
  const fallbackPrompt = approvalConfig.prompt ?? `Approve ${step.id}?`;
  const json = result.json;

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const candidate = json as {
      requiresApproval?: { prompt?: string; items?: unknown[]; preview?: string };
      prompt?: string;
      items?: unknown[];
      preview?: string;
    };
    if (candidate.requiresApproval?.prompt) {
      return {
        type: 'approval_request' as const,
        prompt: candidate.requiresApproval.prompt,
        items: candidate.requiresApproval.items ?? [],
        ...(candidate.requiresApproval.preview ? { preview: candidate.requiresApproval.preview } : null),
      };
    }
    if (candidate.prompt) {
      return {
        type: 'approval_request' as const,
        prompt: candidate.prompt,
        items: candidate.items ?? [],
        ...(candidate.preview ? { preview: candidate.preview } : null),
      };
    }
  }

  const items = approvalConfig.items ?? normalizeApprovalItems(result.json);
  const preview = approvalConfig.preview ?? buildResultPreview(result);

  return {
    type: 'approval_request' as const,
    prompt: fallbackPrompt,
    items,
    ...(preview ? { preview } : null),
  };
}

function parseJson(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function toOutputItems(result: WorkflowStepResult | undefined) {
  if (!result) return [];
  if (result.json !== undefined) {
    return Array.isArray(result.json) ? result.json : [result.json];
  }
  if (result.stdout !== undefined) {
    return result.stdout === '' ? [] : [result.stdout];
  }
  return [];
}

function cloneResults(results: Record<string, WorkflowStepResult>) {
  const out: Record<string, WorkflowStepResult> = {};
  for (const [key, value] of Object.entries(results)) {
    out[key] = { ...value };
  }
  return out;
}

function findLastCompletedStepId(steps: WorkflowStep[], results: Record<string, WorkflowStepResult>) {
  for (let idx = steps.length - 1; idx >= 0; idx--) {
    if (results[steps[idx].id]) return steps[idx].id;
  }
  return null;
}

function isInteractive(stdin: NodeJS.ReadableStream) {
  return Boolean((stdin as NodeJS.ReadStream).isTTY);
}

function parseApprovalTimeoutMs(env: Record<string, string | undefined>) {
  const raw = env?.LOBSTER_APPROVAL_INPUT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

async function runShellCommand({
  command,
  stdin,
  env,
  cwd,
  signal,
}: {
  command: string;
  stdin: string | null;
  env: Record<string, string | undefined>;
  cwd?: string;
  signal?: AbortSignal;
}) {
  const { spawn } = await import('node:child_process');

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const shell = resolveInlineShellCommand({ command, env });
    const child = spawn(shell.command, shell.argv, {
      env: normalizeSpawnEnv(env),
      cwd,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        reject(error);
      }
    });

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    if (typeof stdin === 'string') {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(stdin);
    }
    child.stdin.end();

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new WorkflowCommandError({ code, command, stdout, stderr }));
    });
  });
}

function getTraceStepType(
  step: WorkflowExecutionStep | WorkflowLoopChildStep,
  execution: ReturnType<typeof getStepExecution>,
): WorkflowStepTrace['stepType'] {
  if (execution.kind === 'pipeline') return 'pipeline';
  if (execution.kind === 'shell') return 'shell';
  return 'approval-only';
}

function getStepExecution(step: WorkflowExecutionStep | WorkflowLoopChildStep) {
  if (typeof step.pipeline === 'string' && step.pipeline.trim()) {
    return { kind: 'pipeline' as const, value: step.pipeline };
  }

  const shellCommand = typeof step.run === 'string' ? step.run : step.command;
  if (typeof shellCommand === 'string' && shellCommand.trim()) {
    return { kind: 'shell' as const, value: shellCommand };
  }

  return { kind: 'none' as const };
}

async function runPipelineStep({
  stepId,
  pipelineText,
  inputValue,
  ctx,
  env,
  cwd,
}: {
  stepId: string;
  pipelineText: string;
  inputValue: unknown;
  ctx: RunContext;
  env: Record<string, string | undefined>;
  cwd?: string;
}) {
  let pipeline;
  try {
    pipeline = parsePipeline(pipelineText);
  } catch (err: any) {
    throw new Error(`Workflow step ${stepId} pipeline parse failed: ${err?.message ?? String(err)}`);
  }

  const stdout = new PassThrough();
  let renderedStdout = '';
  let renderedStderr = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    renderedStdout += String(chunk);
  });
  const stderr = new PassThrough();
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk) => {
    renderedStderr += String(chunk);
  });

  const result = await runPipeline({
    pipeline,
    registry: ctx.registry,
    stdin: ctx.stdin,
    stdout,
    stderr,
    env,
    mode: ctx.mode,
    cwd,
    signal: ctx.signal,
    llmAdapters: ctx.llmAdapters,
    input: inputValueToStream(inputValue),
  });
  stdout.end();
  stderr.end();

  if (result.halted) {
    const haltedName = result.haltedAt?.stage?.name ?? 'unknown';
    if (result.items.length === 1 && result.items[0]?.type === 'approval_request') {
      throw new Error(
        `Workflow step ${stepId} halted for approval inside pipeline stage ${haltedName}. Use a separate approval step in the workflow file.`,
      );
    }
    throw new Error(`Workflow step ${stepId} halted before completion at pipeline stage ${haltedName}`);
  }

  const normalizedStdout = renderedStdout || serializePipelineItemsToStdout(result.items);
  const json = result.items.length
    ? (result.items.length === 1 ? result.items[0] : result.items)
    : parseJson(renderedStdout);

  return {
    id: stepId,
    stdout: normalizedStdout,
    stderr: renderedStderr,
    json,
  } satisfies WorkflowStepResult;
}

function createSyntheticStepResult(stepId: string, value: unknown): WorkflowStepResult {
  if (value === null || value === undefined) {
    return { id: stepId };
  }
  if (typeof value === 'string') {
    return {
      id: stepId,
      stdout: value,
      stderr: '',
      json: parseJson(value),
    };
  }
  return {
    id: stepId,
    stdout: serializeValueForStdout(value),
    stderr: '',
    json: value,
  };
}

function buildStdinPreview(value: unknown) {
  if (value === null || value === undefined) return undefined;
  return formatPreview(encodeShellInput(value));
}

function formatPreview(value: string | null | undefined, maxLength = 2000) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

function encodeShellInput(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function* inputValueToItems(value: unknown) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) yield item;
    return;
  }
  yield value;
}

function inputValueToStream(value: unknown) {
  return (async function* () {
    for (const item of inputValueToItems(value)) {
      yield item;
    }
  })();
}

function serializePipelineItemsToStdout(items: unknown[]) {
  if (!items.length) return '';
  if (items.every((item) => typeof item === 'string')) {
    return items.map((item) => String(item)).join('\n');
  }
  if (items.length === 1) {
    return serializeValueForStdout(items[0]);
  }
  return JSON.stringify(items);
}

function serializeValueForStdout(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalizeApprovalConfig(approval: WorkflowStep['approval']) {
  if (approval === true || approval === 'required' || approval === undefined || approval === false) {
    return {} as { prompt?: string; items?: unknown[]; preview?: string };
  }
  if (typeof approval === 'string') {
    return { prompt: approval };
  }
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
    return approval;
  }
  return {} as { prompt?: string; items?: unknown[]; preview?: string };
}

function normalizeApprovalItems(value: unknown) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function buildResultPreview(result: WorkflowStepResult) {
  if (result.stdout) return result.stdout.trim().slice(0, 2000);
  if (result.json !== undefined) return serializeValueForStdout(result.json).trim().slice(0, 2000);
  return undefined;
}
