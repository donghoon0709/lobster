import test from 'node:test';
import assert from 'node:assert/strict';

import { searchReferenceDocs } from '../src/mcp/reference_docs.js';

test('searchReferenceDocs finds command documentation for llm.invoke', () => {
  const result = searchReferenceDocs({
    query: 'llm.invoke',
    areas: ['commands'],
    maxResults: 3,
  });

  assert.equal(result.kind, 'lobster.reference.search');
  assert.equal(result.results.length > 0, true);
  assert.equal(result.results[0]?.area, 'commands');
  assert.match(result.results[0]?.snippet ?? '', /llm\.invoke/i);
});

test('searchReferenceDocs finds workflow syntax sections', () => {
  const result = searchReferenceDocs({
    query: 'approval stdin',
    areas: ['syntax'],
    maxResults: 5,
  });

  assert.equal(result.results.length > 0, true);
  assert.equal(result.results.some((entry) => entry.path === 'docs/lobster-file-syntax.md'), true);
});
