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
import type { EditorState } from './editor-state.js';
import { importWorkflowToEditorState } from './import.js';

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
  const imported = importWorkflowToEditorState(validated.workflow, {
    fileName: `${validated.workflow.name ?? 'generated-draft'}.lobster`,
    hasFileBinding: false,
  });
  return {
    ...imported,
    tasks: imported.tasks.map((task) => (
      task.passthrough.rawConditionValue === undefined
        ? { ...task, conditionField: 'when' }
        : task
    )),
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
