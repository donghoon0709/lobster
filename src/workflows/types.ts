export type WorkflowArgDefinition = {
  default?: unknown;
  description?: string;
};

export type WorkflowApproval =
  | boolean
  | 'required'
  | string
  | {
    prompt?: string;
    items?: unknown[];
    preview?: string;
  };

export type WorkflowStep = {
  id: string;
  command?: string;
  run?: string;
  pipeline?: string;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: unknown;
  approval?: WorkflowApproval;
  condition?: unknown;
  when?: unknown;
};

export type WorkflowFile = {
  name?: string;
  description?: string;
  args?: Record<string, WorkflowArgDefinition>;
  env?: Record<string, string>;
  cwd?: string;
  steps: WorkflowStep[];
};

export type SupportedExecutionMode = 'run' | 'command' | 'pipeline' | 'approval-only';
export type SupportedConditionalField = 'when' | 'condition';
