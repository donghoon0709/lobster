import { parse as parseYaml } from 'yaml';

import { validateSupportedWorkflowFile } from './serialize.js';
import type { WorkflowFile } from './types.js';

export function parseWorkflowFileText(text: string, extension = '.lobster') {
  const normalizedExtension = extension.trim().toLowerCase();
  const parsed = normalizedExtension === '.json'
    ? JSON.parse(text)
    : parseYaml(text);
  return validateSupportedWorkflowFile(parsed as WorkflowFile);
}
