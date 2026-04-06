import type { WorkflowFile } from '../../../src/workflows/types.js';

export type ParseWorkflowResponse =
  | { ok: true; workflow: WorkflowFile }
  | { ok: false; error: string };

export type StudioTestResponse =
  | { ok: true; result: { status: 'success' | 'error' | 'unsupported-approval'; message: string; output?: unknown[]; cliOutput?: string } }
  | { ok: false; error: string };

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Unexpected response from ${url}: ${text || response.statusText}`);
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }
  return payload as T;
}

export function parseWorkflowText(text: string) {
  return postJson<ParseWorkflowResponse>('/api/parse-workflow', { text });
}

export function testWorkflowText(text: string) {
  return postJson<StudioTestResponse>('/api/test-workflow', { text });
}
