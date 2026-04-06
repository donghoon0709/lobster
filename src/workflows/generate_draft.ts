import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { validateSupportedWorkflowFile, serializeWorkflowFile } from './serialize.js';
import type { WorkflowFile } from './types.js';
import {
  buildGeneratedDraftStudioUrl,
  createGeneratedDraftDescriptor,
} from './generated_draft.js';

const DEFAULT_STUDIO_URL = 'http://127.0.0.1:4173/apps/lobster-studio/';

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

function parseLlmWorkflowPayload(output: { data?: any; text?: string | null } | null | undefined) {
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

function normalizeWorkflowPayload(payload: any): WorkflowFile {
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

  const result = await llmCommand.run({
    input: emptyStream(),
    args: {
      _: [],
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      prompt: buildGenerationPrompt(request),
      'output-schema': JSON.stringify(workflowOutputSchema),
      'disable-cache': true,
    },
    ctx,
  });
  const items = await collect(result.output);
  const invocation = items[0];
  const payload = parseLlmWorkflowPayload(invocation?.output);
  const workflow = normalizeWorkflowPayload(payload);
  const text = serializeWorkflowFile(workflow);
  const fileName = buildFileName(workflow);

  let filePath: string | undefined;
  if (destination) {
    filePath = path.resolve(ctx.cwd ?? process.cwd(), destination);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, text, 'utf8');
  }

  const descriptor = createGeneratedDraftDescriptor({
    ...workflow,
  });
  const studioUrl = buildGeneratedDraftStudioUrl({
    descriptor,
    studioBaseUrl: studioBaseUrl || ctx.env?.LOBSTER_STUDIO_URL || DEFAULT_STUDIO_URL,
  });

  return {
    kind: 'lobster.workflow.draft',
    request,
    workflow,
    text,
    fileName,
    ...(filePath ? { filePath } : {}),
    validation: { ok: true },
    studio: {
      url: studioUrl,
      descriptor,
    },
    llm: {
      kind: invocation?.kind ?? 'llm.invoke',
      source: invocation?.source ?? null,
      model: invocation?.model ?? null,
      cached: invocation?.cached ?? false,
    },
  };
}
