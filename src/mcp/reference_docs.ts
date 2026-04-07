import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReferenceArea = 'overview' | 'cli' | 'commands' | 'syntax' | 'mcp';

type ReferenceDoc = {
  area: ReferenceArea;
  path: string;
  title: string;
  text: string;
};

type ReferenceSection = {
  area: ReferenceArea;
  path: string;
  title: string;
  heading: string;
  body: string;
  score: number;
};

export type ReferenceSearchResult = {
  area: ReferenceArea;
  path: string;
  title: string;
  heading: string;
  snippet: string;
  score: number;
};

export type ReferenceSearchResponse = {
  kind: 'lobster.reference.search';
  query: string;
  areas: ReferenceArea[];
  totalMatches: number;
  results: ReferenceSearchResult[];
};

function resolveDocsRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../../docs'),
    path.resolve(here, '../../../docs'),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to locate docs directory from ${here}`);
}

const DOCS_ROOT = resolveDocsRoot();

const DOCS: ReferenceDoc[] = [
  {
    area: 'overview',
    path: 'docs/README.md',
    title: 'Lobster Documentation',
    text: readFileSync(path.join(DOCS_ROOT, 'README.md'), 'utf8'),
  },
  {
    area: 'cli',
    path: 'docs/cli-reference.md',
    title: 'Lobster CLI Reference',
    text: readFileSync(path.join(DOCS_ROOT, 'cli-reference.md'), 'utf8'),
  },
  {
    area: 'commands',
    path: 'docs/command-reference.md',
    title: 'Lobster Command Reference',
    text: readFileSync(path.join(DOCS_ROOT, 'command-reference.md'), 'utf8'),
  },
  {
    area: 'syntax',
    path: 'docs/lobster-file-syntax.md',
    title: 'Lobster File Syntax',
    text: readFileSync(path.join(DOCS_ROOT, 'lobster-file-syntax.md'), 'utf8'),
  },
  {
    area: 'mcp',
    path: 'docs/mcp-server.md',
    title: 'MCP Server Reference',
    text: readFileSync(path.join(DOCS_ROOT, 'mcp-server.md'), 'utf8'),
  },
];

function tokenize(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function extractTitle(markdown: string, fallback: string) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function splitSections(doc: ReferenceDoc) {
  const lines = doc.text.split(/\r?\n/u);
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = doc.title;
  let currentBody: string[] = [];

  const flush = () => {
    const body = currentBody.join('\n').trim();
    if (body) {
      sections.push({ heading: currentHeading, body });
    }
    currentBody = [];
  };

  for (const line of lines) {
    const match = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (match) {
      flush();
      currentHeading = match[2].trim();
      continue;
    }
    currentBody.push(line);
  }
  flush();

  return sections;
}

function scoreSection({
  query,
  tokens,
  title,
  heading,
  body,
  path: sourcePath,
}: {
  query: string;
  tokens: string[];
  title: string;
  heading: string;
  body: string;
  path: string;
}) {
  const haystacks = {
    title: title.toLowerCase(),
    heading: heading.toLowerCase(),
    body: body.toLowerCase(),
    path: sourcePath.toLowerCase(),
  };

  let score = 0;
  if (query && haystacks.body.includes(query)) score += 8;
  if (query && haystacks.heading.includes(query)) score += 10;

  for (const token of tokens) {
    if (haystacks.heading.includes(token)) score += 6;
    if (haystacks.title.includes(token)) score += 4;
    if (haystacks.path.includes(token)) score += 2;
    if (haystacks.body.includes(token)) score += 1;
  }

  return score;
}

function buildSnippet(body: string, query: string, tokens: string[]) {
  const normalized = body.replace(/\s+/gu, ' ').trim();
  if (!normalized) return '';

  const queryIndex = query ? normalized.toLowerCase().indexOf(query) : -1;
  if (queryIndex >= 0) {
    const start = Math.max(0, queryIndex - 80);
    const end = Math.min(normalized.length, queryIndex + 220);
    return normalized.slice(start, end).trim();
  }

  for (const token of tokens) {
    const index = normalized.toLowerCase().indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 80);
      const end = Math.min(normalized.length, index + 220);
      return normalized.slice(start, end).trim();
    }
  }

  return normalized.slice(0, 240).trim();
}

export function searchReferenceDocs({
  query,
  areas,
  maxResults = 5,
}: {
  query: string;
  areas?: ReferenceArea[];
  maxResults?: number;
}): ReferenceSearchResponse {
  const trimmedQuery = String(query ?? '').trim();
  if (!trimmedQuery) {
    throw new Error('reference search requires a non-empty query');
  }

  const normalizedQuery = trimmedQuery.toLowerCase();
  const tokens = tokenize(trimmedQuery);
  const selectedAreas = (areas?.length ? areas : ['overview', 'cli', 'commands', 'syntax', 'mcp']) as ReferenceArea[];
  const selectedDocs = DOCS.filter((doc) => selectedAreas.includes(doc.area)).map((doc) => ({
    ...doc,
    title: extractTitle(doc.text, doc.title),
  }));

  const ranked: ReferenceSection[] = [];
  for (const doc of selectedDocs) {
    for (const section of splitSections(doc)) {
      const score = scoreSection({
        query: normalizedQuery,
        tokens,
        title: doc.title,
        heading: section.heading,
        body: section.body,
        path: doc.path,
      });
      if (score <= 0) continue;
      ranked.push({
        area: doc.area,
        path: doc.path,
        title: doc.title,
        heading: section.heading,
        body: section.body,
        score,
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.heading.localeCompare(b.heading));
  const results = ranked.slice(0, Math.max(1, Math.min(10, maxResults))).map((section) => ({
    area: section.area,
    path: section.path,
    title: section.title,
    heading: section.heading,
    snippet: buildSnippet(section.body, normalizedQuery, tokens),
    score: section.score,
  }));

  return {
    kind: 'lobster.reference.search',
    query: trimmedQuery,
    areas: selectedAreas,
    totalMatches: ranked.length,
    results,
  };
}
