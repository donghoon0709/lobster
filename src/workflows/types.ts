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

type WorkflowStepBase = {
  id: string;
  condition?: unknown;
  when?: unknown;
};

export type WorkflowExecutionStep = WorkflowStepBase & {
  command?: string;
  run?: string;
  pipeline?: string;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: unknown;
  approval?: WorkflowApproval;
};

export type WorkflowLoopChildStep = WorkflowExecutionStep;

export type WorkflowForEachStep = WorkflowStepBase & {
  for_each: string;
  steps: WorkflowLoopChildStep[];
  command?: never;
  run?: never;
  pipeline?: never;
  env?: never;
  cwd?: never;
  stdin?: never;
  approval?: never;
};

export type WorkflowStep = WorkflowExecutionStep | WorkflowForEachStep;

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
