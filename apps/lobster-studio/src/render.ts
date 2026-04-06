import type { SupportedExecutionMode } from '../../../src/workflows/types.js';
import type { EditorState, EditorTask } from './editor-state.js';
import { exportEditorState } from './export.js';

type Actions = {
  onWorkflowFieldChange: (field: 'name' | 'description', value: string) => void;
  onAddArg: () => void;
  onUpdateArg: (id: string, field: 'key' | 'defaultValue' | 'description', value: string) => void;
  onRemoveArg: (id: string) => void;
  onAddEnv: () => void;
  onUpdateEnv: (id: string, field: 'key' | 'value', value: string) => void;
  onRemoveEnv: (id: string) => void;
  onAddTask: () => void;
  onRemoveTask: (index: number) => void;
  onMoveTask: (index: number, direction: -1 | 1) => void;
  onTaskFieldChange: (index: number, field: keyof EditorTask, value: string) => void;
  onExecutionModeChange: (index: number, value: SupportedExecutionMode) => void;
  onConditionFieldChange: (index: number, value: 'when' | 'condition') => void;
  onCopyExport: (text: string) => void;
  onDownloadExport: (fileName: string, text: string) => void;
};

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function selected(mode: SupportedExecutionMode, current: SupportedExecutionMode) {
  return mode === current ? 'selected' : '';
}

function renderExecutionField(
  mode: SupportedExecutionMode,
  current: SupportedExecutionMode,
  label: string,
  value: string,
  key: string,
) {
  const active = current === mode ? 'active' : '';
  return `
    <div class="field-group field-group--full execution-field ${active}">
      <label for="${key}">${label}</label>
      <textarea id="${key}" data-task-field="${key}" ${current === 'approval-only' ? 'disabled' : ''}>${escapeHtml(value)}</textarea>
    </div>
  `;
}

function renderTask(task: EditorTask, index: number, total: number) {
  return `
    <article class="task-card" data-task-index="${index}">
      <div class="task-card__header">
        <div class="task-card__title">
          <span class="task-card__badge">${index + 1}</span>
          <strong>${escapeHtml(task.id || `task_${index + 1}`)}</strong>
        </div>
        <div class="task-card__actions">
          <button type="button" data-move-task="-1" ${index === 0 ? 'disabled' : ''}>Move up</button>
          <button type="button" data-move-task="1" ${index === total - 1 ? 'disabled' : ''}>Move down</button>
          <button type="button" data-remove-task ${total === 1 ? 'disabled' : ''}>Delete</button>
        </div>
      </div>

      <div class="task-grid">
        <div class="field-group">
          <label for="task-id-${index}">Task id</label>
          <input id="task-id-${index}" data-task-field="id" value="${escapeHtml(task.id)}" />
        </div>
        <div class="field-group">
          <label for="task-mode-${index}">Execution mode</label>
          <select id="task-mode-${index}" data-task-mode>
            <option value="command" ${selected(task.executionMode, 'command')}>command</option>
            <option value="run" ${selected(task.executionMode, 'run')}>run</option>
            <option value="pipeline" ${selected(task.executionMode, 'pipeline')}>pipeline</option>
            <option value="approval-only" ${selected(task.executionMode, 'approval-only')}>approval-only</option>
          </select>
        </div>

        ${renderExecutionField('command', task.executionMode, 'command', task.command, `command-${index}`)}
        ${renderExecutionField('run', task.executionMode, 'run', task.run, `run-${index}`)}
        ${renderExecutionField('pipeline', task.executionMode, 'pipeline', task.pipeline, `pipeline-${index}`)}

        <div class="field-group">
          <label for="approval-${index}">Approval prompt</label>
          <input id="approval-${index}" data-task-field="approvalPrompt" value="${escapeHtml(task.approvalPrompt)}" placeholder="Optional unless approval-only" />
        </div>
        <div class="field-group">
          <label for="stdin-${index}">stdin reference</label>
          <input id="stdin-${index}" data-task-field="stdin" value="${escapeHtml(task.stdin)}" placeholder="$task_1.stdout" />
        </div>
        <div class="field-group">
          <label for="condition-field-${index}">Conditional field</label>
          <select id="condition-field-${index}" data-condition-field>
            <option value="when" ${task.conditionField === 'when' ? 'selected' : ''}>when</option>
            <option value="condition" ${task.conditionField === 'condition' ? 'selected' : ''}>condition</option>
          </select>
        </div>
        <div class="field-group">
          <label for="condition-text-${index}">Condition value</label>
          <input id="condition-text-${index}" data-task-field="conditionText" value="${escapeHtml(task.conditionText)}" placeholder="$task_1.approved" />
        </div>
      </div>
    </article>
  `;
}

export function renderEditor(root: HTMLElement, state: EditorState, actions: Actions) {
  let fileName = 'workflow.lobster';
  let text = '';
  let exportError = '';
  try {
    const exportResult = exportEditorState(state);
    fileName = exportResult.fileName;
    text = exportResult.text;
  } catch (error) {
    exportError = error instanceof Error ? error.message : String(error);
  }

  root.innerHTML = `
    <div class="page">
      <main class="panel">
        <section class="hero">
          <div class="eyebrow">v0.2.0 authoring editor</div>
          <h1>Lobster Studio</h1>
          <p>
            Build ordered Lobster workflows as task cards, or start from a generated draft
            handoff, then copy or download a <code>.lobster</code> file.
          </p>
        </section>

        <section class="panel__section">
          <div class="section-header">
            <h2>Workflow metadata</h2>
          </div>
          <div class="meta-grid">
            <div class="field-group">
              <label for="workflow-name">Workflow name</label>
              <input id="workflow-name" value="${escapeHtml(state.name)}" placeholder="sample-workflow" />
            </div>
            <div class="field-group">
              <label for="workflow-description">Description</label>
              <textarea id="workflow-description" placeholder="Optional description">${escapeHtml(state.description)}</textarea>
            </div>
          </div>
        </section>

        <section class="panel__section">
          <div class="section-header">
            <h2>Workflow args</h2>
            <button type="button" id="add-arg">Add arg</button>
          </div>
          <div class="field-help">Args become top-level workflow <code>args</code> entries.</div>
          <div class="table-stack">
            ${state.args.map((entry) => `
              <div class="table-row" data-arg-id="${entry.id}">
                <div class="field-group">
                  <label>Key</label>
                  <input data-arg-field="key" value="${escapeHtml(entry.key)}" />
                </div>
                <div class="field-group">
                  <label>Default</label>
                  <input data-arg-field="defaultValue" value="${escapeHtml(entry.defaultValue)}" />
                </div>
                <div class="field-group">
                  <label>Description</label>
                  <input data-arg-field="description" value="${escapeHtml(entry.description)}" />
                </div>
                <button type="button" class="table-row__remove" data-remove-arg>Remove</button>
              </div>
            `).join('')}
            ${state.args.length === 0 ? '<div class="hint-card">No args yet. Add key/default rows such as <code>location</code> or <code>tag</code>.</div>' : ''}
          </div>
        </section>

        <section class="panel__section">
          <div class="section-header">
            <h2>Workflow env</h2>
            <button type="button" id="add-env">Add env</button>
          </div>
          <div class="field-help">Use env rows for workflow-level environment variables.</div>
          <div class="table-stack">
            ${state.env.map((entry) => `
              <div class="table-row table-row--env" data-env-id="${entry.id}">
                <div class="field-group">
                  <label>Key</label>
                  <input data-env-field="key" value="${escapeHtml(entry.key)}" />
                </div>
                <div class="field-group">
                  <label>Value</label>
                  <input data-env-field="value" value="${escapeHtml(entry.value)}" />
                </div>
                <button type="button" class="table-row__remove" data-remove-env>Remove</button>
              </div>
            `).join('')}
            ${state.env.length === 0 ? '<div class="hint-card">No env entries yet.</div>' : ''}
          </div>
        </section>

        <section class="panel__section">
          <div class="stack-header">
            <h2>Ordered tasks</h2>
            <button type="button" id="add-task-stack">Add task</button>
          </div>
          <div class="field-help">
            Tasks render as ordered cards so execution flow stays visible.
          </div>
          <div class="task-stack">
            ${state.tasks.map((task, index) => renderTask(task, index, state.tasks.length)).join('')}
          </div>
        </section>
      </main>

      <aside class="export-panel">
        <section class="panel">
          <div class="panel__section">
            <div class="section-header">
              <h2>Generated <code>.lobster</code></h2>
            </div>
            <div class="field-help">
              Generated file name: <strong>${escapeHtml(fileName)}</strong>
            </div>
          </div>
          <div class="panel__section">
            <textarea class="export-preview" readonly>${escapeHtml(text)}</textarea>
            <div class="status ${exportError ? 'status--error' : ''}">
              ${escapeHtml(exportError || state.copyStatus)}
            </div>
            <div class="export-actions">
              <button type="button" id="copy-export" ${exportError ? 'disabled' : ''}>Copy .lobster</button>
              <button type="button" id="download-export" ${exportError ? 'disabled' : ''}>Download .lobster</button>
            </div>
          </div>
          <div class="panel__section">
            <div class="hint-card">
              Success demo: create 3 tasks, configure args/env/stdin/when/command/pipeline,
              then export one <code>.lobster</code> file.
            </div>
          </div>
        </section>
      </aside>
    </div>
  `;

  (root.querySelector('#workflow-name') as HTMLInputElement | null)?.addEventListener('change', (event) => {
    actions.onWorkflowFieldChange('name', (event.currentTarget as HTMLInputElement).value ?? '');
  });
  (root.querySelector('#workflow-description') as HTMLTextAreaElement | null)?.addEventListener('change', (event) => {
    actions.onWorkflowFieldChange('description', (event.currentTarget as HTMLTextAreaElement).value ?? '');
  });

  root.querySelector('#add-arg')?.addEventListener('click', () => actions.onAddArg());
  root.querySelector('#add-env')?.addEventListener('click', () => actions.onAddEnv());
  root.querySelector('#add-task-stack')?.addEventListener('click', () => actions.onAddTask());

  for (const row of Array.from(root.querySelectorAll<HTMLElement>('[data-arg-id]'))) {
    const id = row.dataset.argId ?? '';
    Array.from(row.querySelectorAll('[data-arg-field]')).forEach((input) => {
      const fieldTarget = input as HTMLInputElement;
      const field = fieldTarget.dataset.argField as 'key' | 'defaultValue' | 'description';
      fieldTarget.addEventListener('change', (event) =>
        actions.onUpdateArg(id, field, (event.currentTarget as HTMLInputElement).value ?? ''),
      );
    });
    row.querySelector('[data-remove-arg]')?.addEventListener('click', () => actions.onRemoveArg(id));
  }

  for (const row of Array.from(root.querySelectorAll<HTMLElement>('[data-env-id]'))) {
    const id = row.dataset.envId ?? '';
    Array.from(row.querySelectorAll('[data-env-field]')).forEach((input) => {
      const fieldTarget = input as HTMLInputElement;
      const field = fieldTarget.dataset.envField as 'key' | 'value';
      fieldTarget.addEventListener('change', (event) =>
        actions.onUpdateEnv(id, field, (event.currentTarget as HTMLInputElement).value ?? ''),
      );
    });
    row.querySelector('[data-remove-env]')?.addEventListener('click', () => actions.onRemoveEnv(id));
  }

  for (const card of Array.from(root.querySelectorAll<HTMLElement>('[data-task-index]'))) {
    const index = Number(card.dataset.taskIndex);
    card.querySelector('[data-remove-task]')?.addEventListener('click', () => actions.onRemoveTask(index));
    Array.from(card.querySelectorAll<HTMLElement>('[data-move-task]')).forEach((button) => {
      button.addEventListener('click', () => {
        actions.onMoveTask(index, Number(button.dataset.moveTask) as -1 | 1);
      });
    });
    Array.from(card.querySelectorAll('[data-task-field]')).forEach((input) => {
      const fieldTarget = input as HTMLInputElement | HTMLTextAreaElement;
      const field = fieldTarget.dataset.taskField as keyof EditorTask;
      fieldTarget.addEventListener('change', (event) =>
        actions.onTaskFieldChange(index, field, (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value ?? ''),
      );
    });
    (card.querySelector('[data-task-mode]') as HTMLSelectElement | null)?.addEventListener('change', (event) => {
      actions.onExecutionModeChange(index, ((event.currentTarget as HTMLSelectElement).value ?? 'command') as SupportedExecutionMode);
    });
    (card.querySelector('[data-condition-field]') as HTMLSelectElement | null)?.addEventListener('change', (event) => {
      actions.onConditionFieldChange(index, ((event.currentTarget as HTMLSelectElement).value ?? 'when') as 'when' | 'condition');
    });
  }

  if (!exportError) {
    root.querySelector('#copy-export')?.addEventListener('click', () => actions.onCopyExport(text));
    root.querySelector('#download-export')?.addEventListener('click', () => actions.onDownloadExport(fileName, text));
  }
}
