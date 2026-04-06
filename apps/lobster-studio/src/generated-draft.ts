import {
  GENERATED_DRAFT_DESCRIPTOR_KIND,
  GENERATED_DRAFT_DESCRIPTOR_VERSION,
  GENERATED_DRAFT_PATH_ERROR,
  createGeneratedDraftDescriptor,
  decodeGeneratedDraftDescriptor,
  encodeGeneratedDraftDescriptor,
  validateGeneratedDraftDescriptor,
  type GeneratedDraftDescriptor,
} from '../../../src/workflows/generated_draft.js';
import type {
  WorkflowApproval,
  WorkflowArgDefinition,
  WorkflowStep,
} from '../../../src/workflows/types.js';
import type { EditorState, EditorTask } from './editor-state.js';

const GENERATED_DRAFT_PARAM = 'generatedDraft';
const GENERATED_DRAFT_LOADED_STATUS = 'Loaded generated draft.';

type GeneratedDraftSource = 'query' | 'hash';

export type GeneratedDraftHydration =
  | { kind: 'none' }
  | {
    kind: 'loaded';
    source: GeneratedDraftSource;
    descriptor: GeneratedDraftDescriptor;
    state: EditorState;
  }
  | {
    kind: 'error';
    source: GeneratedDraftSource;
    message: string;
  };

function readGeneratedDraftParam(url: URL): { source: GeneratedDraftSource; value: string } | null {
  const searchValue = url.searchParams.get(GENERATED_DRAFT_PARAM);
  if (searchValue !== null) {
    return { source: 'query', value: searchValue };
  }

  const hashValue = new URLSearchParams(url.hash.replace(/^#/u, '')).get(GENERATED_DRAFT_PARAM);
  if (hashValue !== null) {
    return { source: 'hash', value: hashValue };
  }

  return null;
}

function isUnsupportedPathValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.endsWith('.lobster')
    || trimmed.startsWith('file:')
    || trimmed.startsWith('/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || /^[A-Za-z]:[\\/]/u.test(trimmed);
}

function stringifyDraftValue(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function normalizeApprovalPrompt(approval: WorkflowApproval) {
  if (approval === undefined || approval === false || approval === null) return '';
  if (approval === true || approval === 'required') return 'required';
  if (typeof approval === 'string') return approval;
  if (typeof approval === 'object' && typeof approval.prompt === 'string') {
    return approval.prompt;
  }
  return 'required';
}

function determineExecutionMode(step: WorkflowStep): EditorTask['executionMode'] {
  if (typeof step.run === 'string') return 'run';
  if (typeof step.pipeline === 'string') return 'pipeline';
  if (typeof step.command === 'string') return 'command';
  return 'approval-only';
}

function draftArgsToEditorArgs(args: Record<string, WorkflowArgDefinition> | undefined): EditorState['args'] {
  if (!args) return [];
  return Object.entries(args).map(([key, definition], index) => ({
    id: `arg_${index + 1}`,
    key,
    defaultValue: stringifyDraftValue(definition?.default),
    description: definition?.description ?? '',
  }));
}

function draftEnvToEditorEnv(env: Record<string, string> | undefined): EditorState['env'] {
  if (!env) return [];
  return Object.entries(env).map(([key, value], index) => ({
    id: `env_${index + 1}`,
    key,
    value,
  }));
}

function draftStepsToEditorTasks(steps: WorkflowStep[]): EditorState['tasks'] {
  return steps.map((step) => ({
    id: step.id,
    executionMode: determineExecutionMode(step),
    run: typeof step.run === 'string' ? step.run : '',
    command: typeof step.command === 'string' ? step.command : '',
    pipeline: typeof step.pipeline === 'string' ? step.pipeline : '',
    approvalPrompt: normalizeApprovalPrompt(step.approval),
    stdin: stringifyDraftValue(step.stdin),
    conditionField: step.condition !== undefined ? 'condition' : 'when',
    conditionText: stringifyDraftValue(step.condition ?? step.when),
  }));
}

export {
  GENERATED_DRAFT_DESCRIPTOR_KIND,
  GENERATED_DRAFT_DESCRIPTOR_VERSION,
  GENERATED_DRAFT_PATH_ERROR,
  createGeneratedDraftDescriptor,
  encodeGeneratedDraftDescriptor,
};

export function buildGeneratedDraftHandoffUrl(baseUrl: string | URL, descriptor: GeneratedDraftDescriptor) {
  const url = new URL(baseUrl);
  url.searchParams.set(GENERATED_DRAFT_PARAM, encodeGeneratedDraftDescriptor(descriptor));
  return url.toString();
}

export function hydrateEditorStateFromGeneratedDraftDescriptor(descriptor: GeneratedDraftDescriptor): EditorState {
  const validated = validateGeneratedDraftDescriptor(descriptor);
  return {
    name: validated.workflow.name ?? 'generated-draft',
    description: validated.workflow.description ?? '',
    args: draftArgsToEditorArgs(validated.workflow.args),
    env: draftEnvToEditorEnv(validated.workflow.env),
    tasks: draftStepsToEditorTasks(validated.workflow.steps),
    copyStatus: GENERATED_DRAFT_LOADED_STATUS,
  };
}

export function resolveGeneratedDraftHydration(locationHref: string | URL): GeneratedDraftHydration {
  const url = locationHref instanceof URL ? locationHref : new URL(locationHref, 'http://localhost');
  const draftParam = readGeneratedDraftParam(url);
  if (!draftParam) {
    return { kind: 'none' };
  }

  const rawValue = draftParam.value.trim();
  if (!rawValue) {
    return {
      kind: 'error',
      source: draftParam.source,
      message: 'Generated draft handoff is empty.',
    };
  }
  if (isUnsupportedPathValue(rawValue)) {
    return {
      kind: 'error',
      source: draftParam.source,
      message: GENERATED_DRAFT_PATH_ERROR,
    };
  }

  try {
    const descriptor = decodeGeneratedDraftDescriptor(rawValue);
    return {
      kind: 'loaded',
      source: draftParam.source,
      descriptor,
      state: hydrateEditorStateFromGeneratedDraftDescriptor(descriptor),
    };
  } catch (error) {
    return {
      kind: 'error',
      source: draftParam.source,
      message: `Generated draft handoff failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
