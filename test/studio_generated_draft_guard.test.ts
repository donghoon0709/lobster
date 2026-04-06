import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeGeneratedDraftDescriptor,
  resolveGeneratedDraftHydration,
  GENERATED_DRAFT_DESCRIPTOR_KIND,
  GENERATED_DRAFT_DESCRIPTOR_VERSION,
} from '../apps/lobster-studio/src/generated-draft.js';

test('generated draft handoff does not import arbitrary existing .lobster file paths', () => {
  const hydration = resolveGeneratedDraftHydration(
    'https://studio.example/apps/lobster-studio/?generatedDraft=/tmp/existing-workflow.lobster',
  );

  assert.equal(hydration.kind, 'error');
  assert.match(hydration.message, /embedded descriptors, not existing \.lobster file paths/i);
});

test('generated draft descriptor rejects path-based import payloads', () => {
  const encoded = encodeGeneratedDraftDescriptor({
    kind: GENERATED_DRAFT_DESCRIPTOR_KIND,
    version: GENERATED_DRAFT_DESCRIPTOR_VERSION,
    workflow: {
      steps: [
        {
          id: 'placeholder',
          command: 'echo placeholder',
        },
      ],
    },
  });
  const badDescriptor = encodeURIComponent(JSON.stringify({
    kind: GENERATED_DRAFT_DESCRIPTOR_KIND,
    version: GENERATED_DRAFT_DESCRIPTOR_VERSION,
    filePath: '/tmp/existing-workflow.lobster',
    workflow: {
      steps: [
        {
          id: 'placeholder',
          command: 'echo placeholder',
        },
      ],
    },
  }));

  const hydration = resolveGeneratedDraftHydration(
    `https://studio.example/apps/lobster-studio/?generatedDraft=${badDescriptor}`,
  );

  assert.equal(typeof encoded, 'string');
  assert.equal(hydration.kind, 'error');
  assert.match(hydration.message, /embedded descriptors, not existing \.lobster file paths/i);
});
