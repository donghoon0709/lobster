import type { LobsterCommand } from '../types.js';
import { generateWorkflowDraft } from '../../workflows/generate_draft.js';

async function* asStream(items: unknown[]) {
  for (const item of items) yield item;
}

export const workflowsGenerateDraftCommand: LobsterCommand = {
  name: 'workflows.generate_draft',
  meta: {
    description: 'Generate a Lobster workflow draft from a natural-language request',
    argsSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Natural-language workflow request' },
        destination: { type: 'string', description: 'Optional destination file path for the generated .lobster file' },
        provider: { type: 'string', description: 'Optional llm.invoke provider override' },
        model: { type: 'string', description: 'Optional llm.invoke model override' },
        'studio-url': { type: 'string', description: 'Optional Lobster Studio base URL override' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: ['request'],
    },
    sideEffects: ['calls_llm', 'writes_files'],
  },
  help() {
    return (
      'workflows.generate_draft — generate a Lobster workflow draft from natural language\n\n' +
      'Usage:\n' +
      '  workflows.generate_draft --request "Create a weather approval flow" [--destination path/to/file.lobster]\n\n' +
      'Notes:\n' +
      '  - Reuses llm.invoke for draft generation.\n' +
      '  - Returns canonical .lobster text plus a Studio generated-draft handoff descriptor/url.\n'
    );
  },
  async run({ input, args, ctx }) {
    for await (const _item of input) {
      // no-op
    }

    const request = String(args.request ?? args._?.join(' ') ?? '').trim();
    if (!request) {
      throw new Error('workflows.generate_draft requires --request');
    }

    const output = await generateWorkflowDraft({
      request,
      destination: typeof args.destination === 'string' ? args.destination : undefined,
      studioBaseUrl: typeof args['studio-url'] === 'string' ? args['studio-url'] : undefined,
      provider: typeof args.provider === 'string' ? args.provider : undefined,
      model: typeof args.model === 'string' ? args.model : undefined,
      ctx,
    });

    return { output: asStream([output]) };
  },
};
