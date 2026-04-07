import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSpawnEnv } from '../shell.js';

import {
  WorkflowExecutionError,
  loadWorkflowFile,
  resolveWorkflowArgs,
  runWorkflowFile,
  type WorkflowFile,
  type WorkflowRunResult,
  type WorkflowStepTrace,
} from './file.js';

const SUCCESS_MESSAGE = 'Workflow reached the final step successfully.';

export type WorkflowRepairClassification =
  | 'parse'
  | 'missing_inputs'
  | 'runtime'
  | 'cli'
  | 'approval'
  | 'cancelled';

export type WorkflowRepairPlan = {
  classification: WorkflowRepairClassification;
  summary: string;
  evidence: {
    error?: string;
    blockedReason?: string;
    trace?: WorkflowStepTrace[];
    cliOutput?: string;
    runtimeStatus?: WorkflowRunResult['status'] | 'failed';
    cliExitCode?: number | null;
  };
  suggestedEditRequest: string;
  missingArgs?: string[];
  missingEnv?: string[];
};

export type WorkflowTestResult = {
  kind: 'lobster.workflow.test';
  filePath: string;
  success: boolean;
  reachedFinalStep: boolean;
  status: 'success' | 'error' | 'unsupported-approval';
  message: string;
  output: unknown[];
  trace: WorkflowStepTrace[];
  verboseTrace: WorkflowStepTrace[];
  cliOutput?: string;
  cliExitCode?: number | null;
  error?: string;
  blockedReason?: string;
  repairPlan?: WorkflowRepairPlan;
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
  '../../../../bin/lobster.js',
]);

function normalizeArgEnvKey(key: string): string | null {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return null;
  const up = trimmed.toUpperCase();
  const normalized = up.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || null;
}

function visitWorkflowStrings(workflow: WorkflowFile, visit: (value: string | undefined) => void) {
  visit(workflow.cwd);
  for (const value of Object.values(workflow.env ?? {})) visit(value);
  for (const step of workflow.steps) {
    visit(step.command);
    visit(step.run);
    visit(step.pipeline);
    if (typeof step.stdin === 'string') visit(step.stdin);
    if (typeof step.when === 'string') visit(step.when);
    if (typeof step.condition === 'string') visit(step.condition);
    visit(step.cwd);
    for (const value of Object.values(step.env ?? {})) visit(value);
  }
}

export function collectTemplateArgs(workflow: WorkflowFile) {
  const keys = new Set<string>();
  visitWorkflowStrings(workflow, (value) => {
    if (!value) return;
    for (const match of value.matchAll(/\$\{([A-Za-z0-9_-]+)\}/g)) {
      keys.add(match[1]);
    }
  });
  return [...keys];
}

function collectReferencedEnvKeys(workflow: WorkflowFile) {
  const keys = new Set<string>();
  visitWorkflowStrings(workflow, (value) => {
    if (!value) return;
    for (const match of value.matchAll(/\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))/g)) {
      const key = match[1] ?? match[2];
      if (!key) continue;
      if (key === 'LOBSTER_ARGS_JSON' || key.startsWith('LOBSTER_ARG_')) continue;
      keys.add(key);
    }
  });
  return [...keys];
}

export function detectMissingWorkflowInputs({
  workflow,
  workflowArgs,
  env,
}: {
  workflow: WorkflowFile;
  workflowArgs: Record<string, unknown>;
  env: Record<string, string | undefined>;
}) {
  const resolvedArgs = resolveWorkflowArgs(workflow.args, workflowArgs);
  const missingArgs = collectTemplateArgs(workflow)
    .filter((key) => !(key in resolvedArgs) || resolvedArgs[key] === undefined)
    .sort();

  const runtimeEnv = {
    ...env,
    LOBSTER_ARGS_JSON: JSON.stringify(resolvedArgs ?? {}),
  } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(resolvedArgs)) {
    const normalized = normalizeArgEnvKey(key);
    if (!normalized) continue;
    runtimeEnv[`LOBSTER_ARG_${normalized}`] = value === undefined ? undefined : String(value);
  }

  const missingEnv = collectReferencedEnvKeys(workflow)
    .filter((key) => runtimeEnv[key] === undefined)
    .sort();

  return {
    missingArgs,
    missingEnv,
  };
}

function buildSuggestedEditRequest({
  filePath,
  classification,
  summary,
  missingArgs,
  missingEnv,
}: {
  filePath: string;
  classification: WorkflowRepairClassification;
  summary: string;
  missingArgs?: string[];
  missingEnv?: string[];
}) {
  const instructions = [
    `Update ${path.basename(filePath)} so the workflow test passes.`,
    `Address the failure classified as ${classification}.`,
    summary,
  ];

  if (missingArgs?.length) {
    instructions.push(`Provide or remove unresolved workflow args: ${missingArgs.join(', ')}.`);
  }
  if (missingEnv?.length) {
    instructions.push(`Provide defaults, guardrails, or alternative commands for missing environment variables: ${missingEnv.join(', ')}.`);
  }

  instructions.push('Keep the workflow intent intact and avoid adding automatic validation or retry loops.');
  return instructions.join(' ');
}

function buildRepairPlan({
  filePath,
  classification,
  summary,
  error,
  blockedReason,
  trace,
  cliOutput,
  cliExitCode,
  runtimeStatus,
  missingArgs,
  missingEnv,
}: {
  filePath: string;
  classification: WorkflowRepairClassification;
  summary: string;
  error?: string;
  blockedReason?: string;
  trace?: WorkflowStepTrace[];
  cliOutput?: string;
  cliExitCode?: number | null;
  runtimeStatus?: WorkflowRunResult['status'] | 'failed';
  missingArgs?: string[];
  missingEnv?: string[];
}): WorkflowRepairPlan {
  return {
    classification,
    summary,
    evidence: {
      ...(error ? { error } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(trace?.length ? { trace } : {}),
      ...(cliOutput ? { cliOutput } : {}),
      ...(runtimeStatus ? { runtimeStatus } : {}),
      ...(cliExitCode !== undefined ? { cliExitCode } : {}),
    },
    suggestedEditRequest: buildSuggestedEditRequest({
      filePath,
      classification,
      summary,
      missingArgs,
      missingEnv,
    }),
    ...(missingArgs?.length ? { missingArgs } : {}),
    ...(missingEnv?.length ? { missingEnv } : {}),
  };
}

function buildCliOutput({ stdout, stderr }: { stdout: string; stderr: string }) {
  const sections = [];
  if (stderr.trim()) sections.push(stderr.trim());
  if (stdout.trim()) sections.push(stdout.trim());
  return sections.join('\n\n');
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
  const args = [lobsterCliPath, 'run', '--file', filePath, '--verbose'];
  if (Object.keys(workflowArgs).length) {
    args.push('--args-json', JSON.stringify(workflowArgs));
  }

  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ctx.cwd ?? process.cwd(),
      env: normalizeSpawnEnv(ctx.env ?? process.env),
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

async function safeCliRun(filePath: string, workflowArgs: Record<string, unknown>, ctx: any) {
  try {
    return await runHumanCliWorkflow({ filePath, workflowArgs, ctx });
  } catch (error) {
    return {
      code: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function failureResult({
  filePath,
  status = 'error',
  message,
  error,
  blockedReason,
  output = [],
  trace = [],
  cliOutput,
  cliExitCode,
  repairPlan,
}: {
  filePath: string;
  status?: 'error' | 'unsupported-approval';
  message: string;
  error?: string;
  blockedReason?: string;
  output?: unknown[];
  trace?: WorkflowStepTrace[];
  cliOutput?: string;
  cliExitCode?: number | null;
  repairPlan: WorkflowRepairPlan;
}): WorkflowTestResult {
  return {
    kind: 'lobster.workflow.test',
    filePath,
    success: false,
    reachedFinalStep: false,
    status,
    message,
    output,
    trace,
    verboseTrace: trace,
    ...(cliOutput ? { cliOutput } : {}),
    ...(cliExitCode !== undefined ? { cliExitCode } : {}),
    ...(error ? { error } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    repairPlan,
  };
}

export async function testWorkflow({
  filePath,
  workflowArgs = {},
  ctx,
}: {
  filePath: string;
  workflowArgs?: Record<string, unknown>;
  ctx: any;
}): Promise<WorkflowTestResult> {
  const resolvedFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd ?? process.cwd(), filePath);
  if (path.extname(resolvedFilePath).toLowerCase() !== '.lobster') {
    throw new Error('Workflow tests require a .lobster file path');
  }

  let workflow: WorkflowFile;
  try {
    workflow = await loadWorkflowFile(resolvedFilePath);
  } catch (error) {
    const cliRun = await safeCliRun(resolvedFilePath, workflowArgs, ctx);
    const cliOutput = buildCliOutput(cliRun);
    const summary = error instanceof Error ? error.message : String(error);
    return failureResult({
      filePath: resolvedFilePath,
      message: summary,
      error: summary,
      cliOutput,
      cliExitCode: cliRun.code,
      repairPlan: buildRepairPlan({
        filePath: resolvedFilePath,
        classification: 'parse',
        summary,
        error: summary,
        cliOutput,
        cliExitCode: cliRun.code,
        runtimeStatus: 'failed',
      }),
    });
  }

  const { missingArgs, missingEnv } = detectMissingWorkflowInputs({
    workflow,
    workflowArgs,
    env: ctx.env ?? process.env,
  });
  if (missingArgs.length || missingEnv.length) {
    const cliRun = await safeCliRun(resolvedFilePath, workflowArgs, ctx);
    const cliOutput = buildCliOutput(cliRun);
    const parts = [];
    if (missingArgs.length) parts.push(`missing workflow args: ${missingArgs.join(', ')}`);
    if (missingEnv.length) parts.push(`missing environment variables: ${missingEnv.join(', ')}`);
    const blockedReason = `Workflow test blocked by ${parts.join('; ')}`;
    return failureResult({
      filePath: resolvedFilePath,
      message: blockedReason,
      blockedReason,
      cliOutput,
      cliExitCode: cliRun.code,
      repairPlan: buildRepairPlan({
        filePath: resolvedFilePath,
        classification: 'missing_inputs',
        summary: blockedReason,
        blockedReason,
        cliOutput,
        cliExitCode: cliRun.code,
        runtimeStatus: 'failed',
        missingArgs,
        missingEnv,
      }),
    });
  }

  try {
    const runtimeResult = await runWorkflowFile({
      filePath: resolvedFilePath,
      args: workflowArgs,
      ctx: {
        stdin: process.stdin,
        stdout: ctx.stdout ?? process.stdout,
        stderr: ctx.stderr ?? process.stderr,
        env: ctx.env,
        mode: 'tool',
        cwd: ctx.cwd ?? process.cwd(),
        registry: ctx.registry,
        llmAdapters: ctx.llmAdapters,
      },
    });
    const cliRun = await safeCliRun(resolvedFilePath, workflowArgs, ctx);
    const cliOutput = buildCliOutput(cliRun);

    if (runtimeResult.status === 'ok' && cliRun.code === 0) {
      return {
        kind: 'lobster.workflow.test',
        filePath: resolvedFilePath,
        success: true,
        reachedFinalStep: true,
        status: 'success',
        message: SUCCESS_MESSAGE,
        output: runtimeResult.output,
        trace: runtimeResult.trace ?? [],
        verboseTrace: runtimeResult.trace ?? [],
        ...(cliOutput ? { cliOutput } : {}),
        cliExitCode: cliRun.code,
      };
    }

    if (runtimeResult.status === 'needs_approval') {
      const summary = 'Workflow test halted at an approval step.';
      return failureResult({
        filePath: resolvedFilePath,
        status: 'unsupported-approval',
        message: summary,
        output: runtimeResult.output,
        trace: runtimeResult.trace ?? [],
        cliOutput,
        cliExitCode: cliRun.code,
        repairPlan: buildRepairPlan({
          filePath: resolvedFilePath,
          classification: 'approval',
          summary,
          blockedReason: runtimeResult.requiresApproval?.prompt,
          trace: runtimeResult.trace ?? [],
          cliOutput,
          cliExitCode: cliRun.code,
          runtimeStatus: runtimeResult.status,
        }),
      });
    }

    if (runtimeResult.status === 'cancelled') {
      const summary = 'Workflow test was cancelled before completing.';
      return failureResult({
        filePath: resolvedFilePath,
        message: summary,
        output: runtimeResult.output,
        trace: runtimeResult.trace ?? [],
        cliOutput,
        cliExitCode: cliRun.code,
        repairPlan: buildRepairPlan({
          filePath: resolvedFilePath,
          classification: 'cancelled',
          summary,
          trace: runtimeResult.trace ?? [],
          cliOutput,
          cliExitCode: cliRun.code,
          runtimeStatus: runtimeResult.status,
        }),
      });
    }

    const summary = cliRun.code === 0
      ? 'Workflow runtime did not report success.'
      : 'Workflow CLI run failed after runtime execution.';
    return failureResult({
      filePath: resolvedFilePath,
      message: summary,
      output: runtimeResult.output,
      trace: runtimeResult.trace ?? [],
      cliOutput,
      cliExitCode: cliRun.code,
      repairPlan: buildRepairPlan({
        filePath: resolvedFilePath,
        classification: cliRun.code === 0 ? 'runtime' : 'cli',
        summary,
        trace: runtimeResult.trace ?? [],
        cliOutput,
        cliExitCode: cliRun.code,
        runtimeStatus: runtimeResult.status,
      }),
    });
  } catch (error) {
    const cliRun = await safeCliRun(resolvedFilePath, workflowArgs, ctx);
    const cliOutput = buildCliOutput(cliRun);
    const message = error instanceof Error ? error.message : String(error);
    const trace = error instanceof WorkflowExecutionError ? error.trace : [];
    return failureResult({
      filePath: resolvedFilePath,
      message,
      error: message,
      trace,
      cliOutput,
      cliExitCode: cliRun.code,
      repairPlan: buildRepairPlan({
        filePath: resolvedFilePath,
        classification: 'runtime',
        summary: message,
        error: message,
        trace,
        cliOutput,
        cliExitCode: cliRun.code,
        runtimeStatus: 'failed',
      }),
    });
  }
}
