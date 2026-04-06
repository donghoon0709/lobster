import { promises as fsp } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { deleteStateJson, readStateJson, writeStateJson } from '../state/store.js';
import {
  buildDraftArtifacts,
  classifyValidationReadiness,
  executeWorkflowValidation,
  generateCandidateDraft,
  type ValidationAttempt,
  type ValidationOptions,
  type ValidationSummary,
} from './generate_draft.js';
import { parseWorkflowFileText } from './parse.js';
import type { WorkflowFile } from './types.js';

const DEFAULT_STUDIO_URL = 'http://127.0.0.1:4173/apps/lobster-studio/';
const DEFAULT_MAX_SELF_FIX_ATTEMPTS = 3;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

export type EditExistingWorkflowSession = {
  sessionId: string;
  filePath: string;
  originalText: string;
  originalHash: string;
  finalText: string;
  validation: ValidationSummary;
  studio: {
    url: string;
    descriptor: unknown;
  };
  createdAt: string;
  expiresAt: string;
};

export type EditExistingWorkflowResult = {
  kind: 'lobster.workflow.edit';
  request: string;
  filePath: string;
  workflow: WorkflowFile;
  text: string;
  diff: string;
  validation: ValidationSummary;
  studio: {
    url: string;
    descriptor: unknown;
  };
  applySessionId: string;
};

export type ApplyExistingWorkflowResult = {
  kind: 'lobster.workflow.edit.apply';
  filePath: string;
  applied: true;
  fileName: string;
};

function hashText(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function buildEditSessionKey(sessionId: string) {
  return `workflow_edit_session_${sessionId}`;
}

async function resolveExistingWorkflowPath(candidate: string, cwd: string) {
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error('Workflow path is not a file');
  if (path.extname(resolved).toLowerCase() !== '.lobster') {
    throw new Error('Existing workflow edits require a .lobster file path');
  }
  return resolved;
}

function buildEditPrompt({
  request,
  filePath,
  originalText,
}: {
  request: string;
  filePath: string;
  originalText: string;
}) {
  return [
    'Revise the existing Lobster workflow to satisfy the request.',
    'Return exactly one JSON object for a Lobster workflow.',
    'Do not return Markdown, code fences, comments, or explanations.',
    'Preserve the original workflow intent unless the request explicitly changes it.',
    'Prefer minimal edits over adding unrelated validation/debug scaffolding.',
    '',
    'Target file path:',
    filePath,
    '',
    'Edit request:',
    request,
    '',
    'Current workflow file:',
    originalText,
  ].join('\n');
}

function buildEditRepairPrompt({
  request,
  filePath,
  originalText,
  previousDraft,
  previousAttempt,
  remainingAttempts,
}: {
  request: string;
  filePath: string;
  originalText: string;
  previousDraft: WorkflowFile;
  previousAttempt: ValidationAttempt;
  remainingAttempts: number;
}) {
  return [
    'Revise the existing Lobster workflow JSON to fix the observed validation/runtime issue.',
    'Return exactly one JSON object for a Lobster workflow.',
    'Do not return Markdown, code fences, comments, or explanations.',
    'Preserve the original workflow purpose and the user request.',
    'Avoid adding unrelated validation/debug steps unless strictly necessary to satisfy the request.',
    `Remaining repair attempts after this response: ${remainingAttempts}`,
    '',
    'Target file path:',
    filePath,
    '',
    'Original workflow file:',
    originalText,
    '',
    'User edit request:',
    request,
    '',
    'Previous edited workflow draft:',
    JSON.stringify(previousDraft, null, 2),
    '',
    'Validation evidence:',
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

function buildLineDiff(before: string, after: string) {
  if (before === after) return 'No changes.';
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n');
  const afterLines = after.replace(/\r\n/g, '\n').split('\n');
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  const lines = ['--- original', '+++ edited'];
  for (let index = 0; index < maxLength; index++) {
    const prev = beforeLines[index];
    const next = afterLines[index];
    if (prev === next) {
      if (prev !== undefined) lines.push(` ${prev}`);
      continue;
    }
    if (prev !== undefined) lines.push(`-${prev}`);
    if (next !== undefined) lines.push(`+${next}`);
  }
  return `${lines.join('\n')}\n`;
}

async function readWorkflowText(filePath: string) {
  const text = await fsp.readFile(filePath, 'utf8');
  parseWorkflowFileText(text, '.lobster');
  return text;
}

async function saveEditSession({
  env,
  session,
}: {
  env: Record<string, string | undefined>;
  session: EditExistingWorkflowSession;
}) {
  await writeStateJson({
    env,
    key: buildEditSessionKey(session.sessionId),
    value: session,
  });
}

async function loadEditSession({
  env,
  sessionId,
}: {
  env: Record<string, string | undefined>;
  sessionId: string;
}) {
  const stored = await readStateJson({ env, key: buildEditSessionKey(sessionId) });
  if (!stored || typeof stored !== 'object') {
    throw new Error('Edit session not found');
  }
  return stored as EditExistingWorkflowSession;
}

async function deleteEditSession({
  env,
  sessionId,
}: {
  env: Record<string, string | undefined>;
  sessionId: string;
}) {
  await deleteStateJson({ env, key: buildEditSessionKey(sessionId) });
}

export async function editExistingWorkflow({
  filePath,
  request,
  studioBaseUrl,
  provider,
  model,
  validation,
  ctx,
}: {
  filePath: string;
  request: string;
  studioBaseUrl?: string;
  provider?: string;
  model?: string;
  validation?: ValidationOptions;
  ctx: any;
}): Promise<EditExistingWorkflowResult> {
  const llmCommand = ctx.registry?.get('llm.invoke');
  if (!llmCommand) {
    throw new Error('llm.invoke command is required for workflow editing');
  }

  const resolvedFilePath = await resolveExistingWorkflowPath(filePath, ctx.cwd ?? process.cwd());
  const originalText = await readWorkflowText(resolvedFilePath);
  const studioBase = studioBaseUrl || ctx.env?.LOBSTER_STUDIO_URL || DEFAULT_STUDIO_URL;
  const maxRepairAttempts = Math.max(
    0,
    Math.min(DEFAULT_MAX_SELF_FIX_ATTEMPTS, validation?.maxRepairAttempts ?? DEFAULT_MAX_SELF_FIX_ATTEMPTS),
  );
  const workflowArgs = validation?.workflowArgs ?? {};

  const generation = await generateCandidateDraft({
    llmCommand,
    prompt: buildEditPrompt({
      request,
      filePath: resolvedFilePath,
      originalText,
    }),
    provider,
    model,
    ctx,
  });

  let currentDraft = buildDraftArtifacts(generation.draft, studioBase);
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
          prompt: buildEditRepairPrompt({
            request,
            filePath: resolvedFilePath,
            originalText,
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

  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS).toISOString();
  await saveEditSession({
    env: ctx.env,
    session: {
      sessionId,
      filePath: resolvedFilePath,
      originalText,
      originalHash: hashText(originalText),
      finalText: currentDraft.text,
      validation: validationResult,
      studio: currentDraft.studio,
      createdAt,
      expiresAt,
    },
  });

  return {
    kind: 'lobster.workflow.edit',
    request,
    filePath: resolvedFilePath,
    workflow: currentDraft.workflow,
    text: currentDraft.text,
    diff: buildLineDiff(originalText, currentDraft.text),
    validation: validationResult,
    studio: currentDraft.studio,
    applySessionId: sessionId,
  };
}

export async function applyExistingWorkflowEdit({
  sessionId,
  ctx,
}: {
  sessionId: string;
  ctx: any;
}): Promise<ApplyExistingWorkflowResult> {
  const session = await loadEditSession({ env: ctx.env, sessionId });
  const now = Date.now();
  if (Number.isNaN(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) < now) {
    await deleteEditSession({ env: ctx.env, sessionId });
    throw new Error('Edit session expired. Run propose/edit again.');
  }

  const resolvedFilePath = await resolveExistingWorkflowPath(session.filePath, ctx.cwd ?? process.cwd());
  const currentText = await fsp.readFile(resolvedFilePath, 'utf8');
  if (hashText(currentText) !== session.originalHash) {
    throw new Error('Source workflow changed after propose/edit. Run propose/edit again.');
  }

  await fsp.writeFile(resolvedFilePath, session.finalText, 'utf8');
  await deleteEditSession({ env: ctx.env, sessionId });

  return {
    kind: 'lobster.workflow.edit.apply',
    filePath: resolvedFilePath,
    applied: true,
    fileName: path.basename(resolvedFilePath),
  };
}
