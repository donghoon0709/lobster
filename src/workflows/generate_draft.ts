import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { validateSupportedWorkflowFile, serializeWorkflowFile } from './serialize.js';
import type { WorkflowFile } from './types.js';
import {
  buildGeneratedDraftStudioUrl,
  createGeneratedDraftDescriptor,
} from './generated_draft.js';
import {
  WorkflowExecutionError,
  resolveWorkflowArgs,
  runWorkflowFile,
  type WorkflowStepTrace,
} from './file.js';

const DEFAULT_STUDIO_URL = 'http://127.0.0.1:4173/apps/lobster-studio/';
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
const silentWritable = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const workflowOutputSchema = {
  type: 'object',
  required: ['steps'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          command: { type: 'string' },
          run: { type: 'string' },
          pipeline: { type: 'string' },
          stdin: { type: 'string' },
          approval: {
            anyOf: [
              { type: 'boolean' },
              { type: 'string' },
            ],
          },
          when: { type: 'string' },
          condition: { type: 'string' },
        },
      },
    },
  },
};

function emptyStream() {
  return (async function* () {})();
}

async function collect(iterable: AsyncIterable<any>) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export function parseLlmWorkflowPayload(output: { data?: any; text?: string | null } | null | undefined) {
  if (!output) {
    throw new Error('llm.invoke returned no output');
  }

  if (output.data && typeof output.data === 'object') {
    return output.data;
  }

  if (typeof output.text === 'string' && output.text.trim()) {
    try {
      return JSON.parse(output.text);
    } catch (error) {
      throw new Error(`llm.invoke returned non-JSON draft text: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error('llm.invoke returned no structured workflow draft');
}

export function normalizeWorkflowPayload(payload: any): WorkflowFile {
  const candidate = payload?.workflow ?? payload;
  return validateSupportedWorkflowFile(candidate as WorkflowFile);
}

function buildGenerationPrompt(request: string) {
  return [
    'Return exactly one JSON object for a Lobster workflow.',
    'Do not use a wrapper key like "workflow".',
    'Do not return Markdown, code fences, comments, or explanations.',
    'The top-level object itself must satisfy the provided JSON schema exactly.',
    'Use only these top-level fields unless absolutely needed: name, description, steps.',
    'Lobster-specific rules:',
    '- steps must be an array of step objects.',
    '- every step must have an id string.',
    '- each step may define exactly one execution field: run OR command OR pipeline.',
    '- pipeline must be a single string, never an array, never nested step objects.',
    '- approval must be a plain string unless the request explicitly requires a richer approval object.',
    '- if one step consumes prior JSON output, use stdin with a step reference like "$fetch_pr_info.json".',
    '- use when or condition, but never both on the same step.',
    '- do not invent fields outside the schema.',
    '- avoid shell redirection to files; prefer Lobster step refs and stdin chaining.',
    'Preferred shape for this request:',
    '{',
    '  "name": "github_pr_summary_with_approval",',
    '  "description": "Fetch GitHub PR info, summarize it with an LLM, then ask for human approval.",',
    '  "steps": [',
    '    { "id": "fetch_pr_info", "run": "gh pr view ${pr} --repo ${repo} --json title,body,files,reviews" },',
    '    { "id": "summarize_pr", "pipeline": "llm.invoke --prompt \\"Summarize this PR in Korean as bullet points.\\"", "stdin": "$fetch_pr_info.json" },',
    '    { "id": "final_approval", "approval": "Approve this PR summary?", "stdin": "$summarize_pr.json" }',
    '  ]',
    '}',
    '',
    'Natural-language request:',
    request,
  ].join('\n');
}

function buildFileName(workflow: WorkflowFile) {
  const raw = typeof workflow.name === 'string' ? workflow.name : 'generated-workflow';
  const base = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'generated-workflow'}.lobster`;
}

export function buildDraftArtifacts(workflow: WorkflowFile, studioBaseUrl: string) {
  const text = serializeWorkflowFile(workflow);
  const fileName = buildFileName(workflow);
  const descriptor = createGeneratedDraftDescriptor({
    ...workflow,
  });
  const studioUrl = buildGeneratedDraftStudioUrl({
    descriptor,
    studioBaseUrl,
  });
  return {
    workflow,
    text,
    fileName,
    studio: {
      url: studioUrl,
      descriptor,
    },
  };
}

export type ValidationStatus = 'generation_only' | 'validation_skipped' | 'validated' | 'failed_after_retries';

export type ValidationAttempt = {
  attempt: number;
  status: 'validated' | 'failed';
  output?: unknown[];
  trace?: WorkflowStepTrace[];
  error?: string;
  cliOutput?: string;
};

export type ValidationSummary = {
  ok: boolean;
  status: ValidationStatus;
  attempts: ValidationAttempt[];
  blockedReason?: string;
  missingArgs?: string[];
};

export type ValidationOptions = {
  enabled?: boolean;
  workflowArgs?: Record<string, unknown>;
  maxRepairAttempts?: number;
};

function resolveRuntimePath(relativeCandidates: string[]) {
  for (const candidate of relativeCandidates) {
    const candidatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  throw new Error(`Unable to locate Lobster CLI from ${fileURLToPath(import.meta.url)}`);
}

const lobsterCliPath = resolveRuntimePath([
  '../../../bin/lobster.js',
]);

export function collectTemplateArgs(workflow: WorkflowFile) {
  const keys = new Set<string>();
  const visitString = (value: string | undefined) => {
    if (!value) return;
    for (const match of value.matchAll(/\$\{([A-Za-z0-9_-]+)\}/g)) {
      keys.add(match[1]);
    }
  };

  visitString(workflow.cwd);
  for (const value of Object.values(workflow.env ?? {})) visitString(value);
  for (const step of workflow.steps) {
    visitString(step.command);
    visitString(step.run);
    visitString(step.pipeline);
    if (typeof step.stdin === 'string') visitString(step.stdin);
    if (typeof step.when === 'string') visitString(step.when);
    if (typeof step.condition === 'string') visitString(step.condition);
    visitString(step.cwd);
    for (const value of Object.values(step.env ?? {})) visitString(value);
  }
  return [...keys];
}

export function classifyValidationReadiness(workflow: WorkflowFile, workflowArgs: Record<string, unknown>) {
  const resolvedArgs = resolveWorkflowArgs(workflow.args, workflowArgs);
  const requiredArgs = collectTemplateArgs(workflow);
  const missingArgs = requiredArgs.filter((key) => !(key in resolvedArgs) || resolvedArgs[key] === undefined);
  if (missingArgs.length) {
    return {
      allowed: false,
      blockedReason: `Missing required workflow args for validation: ${missingArgs.join(', ')}`,
      missingArgs,
    };
  }

  if (workflow.steps.some((step) => step.approval !== undefined && step.approval !== false && step.approval !== null)) {
    return {
      allowed: false,
      blockedReason: 'Validation skipped because approval workflows are not auto-executed.',
      missingArgs: [],
    };
  }

  for (const step of workflow.steps) {
    if (typeof step.pipeline === 'string' && step.pipeline.trim()) {
      if (!step.pipeline.trim().startsWith('llm.invoke')) {
        return {
          allowed: false,
          blockedReason: `Validation skipped because pipeline step ${step.id} is not classified as low-risk.`,
          missingArgs: [],
        };
      }
      continue;
    }

    const command = (typeof step.run === 'string' ? step.run : step.command)?.trim();
    if (!command) continue;
    if (/^(printf|echo|cat)\b/u.test(command)) continue;
    if (/^gh (pr|issue|repo) view\b/u.test(command)) continue;

    return {
      allowed: false,
      blockedReason: `Validation skipped because step ${step.id} is not classified as low-risk.`,
      missingArgs: [],
    };
  }

  return {
    allowed: true,
    blockedReason: undefined,
    missingArgs: [],
  };
}

export async function runHumanCliWorkflow({
  filePath,
  workflowArgs,
  ctx,
}: {
  filePath: string;
  workflowArgs: Record<string, unknown>;
  ctx: any;
}) {
  const args = [lobsterCliPath, 'run', '--file', filePath];
  if (Object.keys(workflowArgs).length) {
    args.push('--args-json', JSON.stringify(workflowArgs));
  }

  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ctx.cwd ?? process.cwd(),
      env: ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function executeWorkflowValidation({
  draft,
  workflowArgs,
  ctx,
}: {
  draft: ReturnType<typeof buildDraftArtifacts>;
  workflowArgs: Record<string, unknown>;
  ctx: any;
}) {
  const tempDir = await fsp.mkdtemp(path.join(ctx.cwd ?? process.cwd(), '.lobster-draft-validation-'));
  const filePath = path.join(tempDir, draft.fileName);
  await fsp.writeFile(filePath, draft.text, 'utf8');
  try {
    const result = await runWorkflowFile({
      filePath,
      args: workflowArgs,
      ctx: {
        stdin: process.stdin,
        stdout: silentWritable,
        stderr: silentWritable,
        env: ctx.env,
        mode: 'tool',
        cwd: ctx.cwd ?? process.cwd(),
        registry: ctx.registry,
        llmAdapters: ctx.llmAdapters,
      },
    });

    if (result.status === 'ok') {
      return {
        status: 'validated' as const,
        output: result.output,
        trace: result.trace ?? [],
        cliOutput: '',
      };
    }

    const cliRun = await runHumanCliWorkflow({ filePath, workflowArgs, ctx });
    return {
      status: 'failed' as const,
      output: result.output,
      trace: result.trace ?? [],
      error: result.status === 'needs_approval'
        ? 'Validation halted for approval.'
        : 'Validation did not complete.',
      cliOutput: `${cliRun.stderr.trim()}${cliRun.stderr.trim() && cliRun.stdout.trim() ? '\n\n' : ''}${cliRun.stdout.trim()}`.trim(),
    };
  } catch (error) {
    const cliRun = await runHumanCliWorkflow({ filePath, workflowArgs, ctx });
    return {
      status: 'failed' as const,
      trace: error instanceof WorkflowExecutionError ? error.trace : [],
      error: error instanceof Error ? error.message : String(error),
      cliOutput: `${cliRun.stderr.trim()}${cliRun.stderr.trim() && cliRun.stdout.trim() ? '\n\n' : ''}${cliRun.stdout.trim()}`.trim(),
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

function buildRepairPrompt({
  request,
  previousDraft,
  previousAttempt,
  remainingAttempts,
}: {
  request: string;
  previousDraft: WorkflowFile;
  previousAttempt: ValidationAttempt;
  remainingAttempts: number;
}) {
  return [
    'Revise the Lobster workflow JSON to fix the observed runtime failure.',
    'Return exactly one JSON object for a Lobster workflow.',
    'Do not return Markdown, code fences, comments, or explanations.',
    'Preserve the original user intent while fixing the execution issue.',
    `Remaining repair attempts after this response: ${remainingAttempts}`,
    '',
    'Original request:',
    request,
    '',
    'Previous workflow draft:',
    JSON.stringify(previousDraft, null, 2),
    '',
    'Structured execution evidence:',
    JSON.stringify({
      status: previousAttempt.status,
      output: previousAttempt.output,
      trace: previousAttempt.trace,
      error: previousAttempt.error,
    }, null, 2),
    '',
    'CLI diagnostics:',
    previousAttempt.cliOutput || '(none)',
  ].join('\n');
}

export async function generateCandidateDraft({
  llmCommand,
  prompt,
  provider,
  model,
  ctx,
}: {
  llmCommand: any;
  prompt: string;
  provider?: string;
  model?: string;
  ctx: any;
}) {
  const result = await llmCommand.run({
    input: emptyStream(),
    args: {
      _: [],
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      prompt,
      'output-schema': JSON.stringify(workflowOutputSchema),
      'disable-cache': true,
    },
    ctx,
  });
  const items = await collect(result.output);
  const invocation = items[0];
  const payload = parseLlmWorkflowPayload(invocation?.output);
  const workflow = normalizeWorkflowPayload(payload);
  return {
    invocation,
    draft: workflow,
  };
}

export async function generateWorkflowDraft({
  request,
  destination,
  studioBaseUrl,
  provider,
  model,
  validation,
  ctx,
}: {
  request: string;
  destination?: string;
  studioBaseUrl?: string;
  provider?: string;
  model?: string;
  validation?: ValidationOptions;
  ctx: any;
}) {
  const llmCommand = ctx.registry?.get('llm.invoke');
  if (!llmCommand) {
    throw new Error('llm.invoke command is required for workflow draft generation');
  }

  const generation = await generateCandidateDraft({
    llmCommand,
    prompt: buildGenerationPrompt(request),
    provider,
    model,
    ctx,
  });
  const studioBase = studioBaseUrl || ctx.env?.LOBSTER_STUDIO_URL || DEFAULT_STUDIO_URL;
  let currentDraft = buildDraftArtifacts(generation.draft, studioBase);
  const maxRepairAttempts = Math.max(0, Math.min(DEFAULT_MAX_REPAIR_ATTEMPTS, validation?.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS));
  const workflowArgs = validation?.workflowArgs ?? {};
  let validationResult: ValidationSummary = {
    ok: true,
    status: 'generation_only',
    attempts: [],
  };

  if (validation?.enabled) {
    const readiness = classifyValidationReadiness(currentDraft.workflow, workflowArgs);
    if (!readiness.allowed) {
      validationResult = {
        ok: true,
        status: 'validation_skipped',
        blockedReason: readiness.blockedReason,
        missingArgs: readiness.missingArgs,
        attempts: [],
      };
    } else {
      for (let attemptIndex = 0; attemptIndex <= maxRepairAttempts; attemptIndex++) {
        const execution = await executeWorkflowValidation({
          draft: currentDraft,
          workflowArgs,
          ctx,
        });
        const attempt: ValidationAttempt = {
          attempt: attemptIndex + 1,
          status: execution.status === 'validated' ? 'validated' : 'failed',
          output: execution.output,
          trace: execution.trace,
          error: execution.error,
          cliOutput: execution.cliOutput,
        };
        validationResult.attempts.push(attempt);

        if (execution.status === 'validated') {
          validationResult = {
            ok: true,
            status: 'validated',
            attempts: validationResult.attempts,
          };
          break;
        }

        if (attemptIndex === maxRepairAttempts) {
          validationResult = {
            ok: false,
            status: 'failed_after_retries',
            attempts: validationResult.attempts,
          };
          break;
        }

        const repair = await generateCandidateDraft({
          llmCommand,
          prompt: buildRepairPrompt({
            request,
            previousDraft: currentDraft.workflow,
            previousAttempt: attempt,
            remainingAttempts: maxRepairAttempts - attemptIndex,
          }),
          provider,
          model,
          ctx,
        });
        currentDraft = buildDraftArtifacts(repair.draft, studioBase);
        const nextReadiness = classifyValidationReadiness(currentDraft.workflow, workflowArgs);
        if (!nextReadiness.allowed) {
          validationResult = {
            ok: false,
            status: 'failed_after_retries',
            blockedReason: nextReadiness.blockedReason,
            missingArgs: nextReadiness.missingArgs,
            attempts: validationResult.attempts,
          };
          break;
        }
      }
    }
  }

  let filePath: string | undefined;
  if (destination) {
    filePath = path.resolve(ctx.cwd ?? process.cwd(), destination);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, currentDraft.text, 'utf8');
  }

  return {
    kind: 'lobster.workflow.draft',
    request,
    workflow: currentDraft.workflow,
    text: currentDraft.text,
    fileName: currentDraft.fileName,
    ...(filePath ? { filePath } : {}),
    validation: validationResult,
    studio: currentDraft.studio,
    llm: {
      kind: generation.invocation?.kind ?? 'llm.invoke',
      source: generation.invocation?.source ?? null,
      model: generation.invocation?.model ?? null,
      cached: generation.invocation?.cached ?? false,
    },
  };
}
