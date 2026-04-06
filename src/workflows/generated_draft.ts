import { validateSupportedWorkflowFile } from './serialize.js';
import type { WorkflowFile } from './types.js';

export const GENERATED_DRAFT_DESCRIPTOR_KIND = 'lobster-studio-generated-draft';
export const GENERATED_DRAFT_DESCRIPTOR_VERSION = 1;
export const GENERATED_DRAFT_PATH_ERROR = 'Generated draft handoff only accepts embedded descriptors, not existing .lobster file paths.';

export type GeneratedDraftDescriptor = {
  kind: typeof GENERATED_DRAFT_DESCRIPTOR_KIND;
  version: typeof GENERATED_DRAFT_DESCRIPTOR_VERSION;
  workflow: WorkflowFile;
};

function encodeDescriptor(text: string) {
  return encodeURIComponent(text);
}

function decodeDescriptor(text: string) {
  return decodeURIComponent(text);
}

export function validateGeneratedDraftDescriptor(value: unknown): GeneratedDraftDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Generated draft descriptor must be a JSON object.');
  }

  const descriptor = value as Record<string, unknown>;
  if (descriptor.kind !== GENERATED_DRAFT_DESCRIPTOR_KIND) {
    throw new Error(`Generated draft descriptor kind must be ${GENERATED_DRAFT_DESCRIPTOR_KIND}.`);
  }
  if (descriptor.version !== GENERATED_DRAFT_DESCRIPTOR_VERSION) {
    throw new Error(`Generated draft descriptor version must be ${GENERATED_DRAFT_DESCRIPTOR_VERSION}.`);
  }
  if ('filePath' in descriptor || 'path' in descriptor || 'url' in descriptor) {
    throw new Error(GENERATED_DRAFT_PATH_ERROR);
  }

  return {
    kind: GENERATED_DRAFT_DESCRIPTOR_KIND,
    version: GENERATED_DRAFT_DESCRIPTOR_VERSION,
    workflow: validateSupportedWorkflowFile(descriptor.workflow as WorkflowFile),
  };
}

export function createGeneratedDraftDescriptor(workflow: WorkflowFile): GeneratedDraftDescriptor {
  return {
    kind: GENERATED_DRAFT_DESCRIPTOR_KIND,
    version: GENERATED_DRAFT_DESCRIPTOR_VERSION,
    workflow: validateSupportedWorkflowFile(workflow),
  };
}

export function encodeGeneratedDraftDescriptor(descriptor: GeneratedDraftDescriptor) {
  return encodeDescriptor(JSON.stringify(validateGeneratedDraftDescriptor(descriptor)));
}

export function decodeGeneratedDraftDescriptor(encoded: string): GeneratedDraftDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeDescriptor(encoded));
  } catch (error) {
    throw new Error(`Invalid generated draft descriptor: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateGeneratedDraftDescriptor(parsed);
}

export function buildGeneratedDraftStudioUrl({
  descriptor,
  studioBaseUrl,
}: {
  descriptor: GeneratedDraftDescriptor;
  studioBaseUrl: string;
}) {
  const url = new URL(studioBaseUrl);
  url.searchParams.set('generatedDraft', encodeGeneratedDraftDescriptor(descriptor));
  return url.toString();
}
