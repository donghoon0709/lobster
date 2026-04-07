import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { validateSupportedWorkflowFile, serializeWorkflowFile } from './serialize.js';
import type { WorkflowFile } from './types.js';
import {
  buildGeneratedDraftStudioUrl,
  createGeneratedDraftDescriptor,
} from './generated_draft.js';

const DEFAULT_STUDIO_URL = 'http://127.0.0.1:4173/apps/lobster-studio/';
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
    '    { "id": "summarize_pr", "pipeline": "llm.invoke --prompt \\\"Summarize this PR in Korean as bullet points.\\\"", "stdin": "$fetch_pr_info.json" },',
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
    ctx: {
      ...ctx,
      stdout: ctx.stdout ?? silentWritable,
      stderr: ctx.stderr ?? silentWritable,
    },
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
  ctx,
}: {
  request: string;
  destination?: string;
  studioBaseUrl?: string;
  provider?: string;
  model?: string;
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
  const draft = buildDraftArtifacts(generation.draft, studioBase);

  let filePath: string | undefined;
  if (destination) {
    filePath = path.resolve(ctx.cwd ?? process.cwd(), destination);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, draft.text, 'utf8');
  }

  return {
    kind: 'lobster.workflow.draft',
    request,
    workflow: draft.workflow,
    text: draft.text,
    fileName: draft.fileName,
    ...(filePath ? { filePath } : {}),
    studio: draft.studio,
    llm: {
      kind: generation.invocation?.kind ?? 'llm.invoke',
      source: generation.invocation?.source ?? null,
      model: generation.invocation?.model ?? null,
      cached: generation.invocation?.cached ?? false,
    },
  };
}
