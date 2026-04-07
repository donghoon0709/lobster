import type { SupportedExecutionMode } from '../../../src/workflows/types.js';
import type { EditorState, EditorTask, EditorTaskKind } from './editor-state.js';
import { exportEditorState } from './export.js';

type Actions = {
  onOpenFile: () => void;
  onSaveFile: (fileName: string, text: string) => void;
  onRunTest: (text: string) => void;
  onWorkflowFieldChange: (field: 'name' | 'description', value: string) => void;
  onAddArg: () => void;
  onUpdateArg: (id: string, field: 'key' | 'defaultValue' | 'description', value: string) => void;
  onRemoveArg: (id: string) => void;
  onAddEnv: () => void;
  onUpdateEnv: (id: string, field: 'key' | 'value', value: string) => void;
  onRemoveEnv: (id: string) => void;
  onAddTask: () => void;
  onAddChildTask: (index: number) => void;
  onRemoveTask: (index: number) => void;
  onRemoveChildTask: (index: number, childIndex: number) => void;
  onMoveTask: (index: number, direction: -1 | 1) => void;
  onMoveChildTask: (index: number, childIndex: number, direction: -1 | 1) => void;
  onTaskFieldChange: (index: number, field: keyof EditorTask, value: string) => void;
  onChildTaskFieldChange: (index: number, childIndex: number, field: keyof EditorTask, value: string) => void;
  onTaskKindChange: (index: number, value: EditorTaskKind) => void;
  onExecutionModeChange: (index: number, value: SupportedExecutionMode) => void;
  onChildExecutionModeChange: (index: number, childIndex: number, value: SupportedExecutionMode) => void;
  onConditionFieldChange: (index: number, value: 'when' | 'condition') => void;
  onChildConditionFieldChange: (index: number, childIndex: number, value: 'when' | 'condition') => void;
  onCopyExport: (text: string) => void;
};

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function selected<T extends string>(value: T, current: T) {
  return value === current ? 'selected' : '';
}

function renderExecutionField(
  mode: SupportedExecutionMode,
  current: SupportedExecutionMode,
  field: 'command' | 'run' | 'pipeline',
  label: string,
  value: string,
  elementId: string,
  disabled: boolean,
) {
  const active = current === mode ? 'active' : '';
  return `
    <div class="field-group field-group--full execution-field ${active}">
      <label for="${elementId}">${label}</label>
      <textarea id="${elementId}" data-task-field="${field}" ${disabled ? 'disabled' : ''}>${escapeHtml(value)}</textarea>
    </div>
  `;
}

function renderLeafTask(task: EditorTask, prefix: string, disableApprovalOnly = false) {
  return `
    <div class="task-grid">
      <div class="field-group">
        <label for="${prefix}-id">Task id</label>
        <input id="${prefix}-id" data-task-field="id" value="${escapeHtml(task.id)}" />
      </div>
      <div class="field-group">
        <label for="${prefix}-mode">Execution mode</label>
        <select id="${prefix}-mode" data-task-mode>
          <option value="command" ${selected(task.executionMode, 'command')}>command</option>
          <option value="run" ${selected(task.executionMode, 'run')}>run</option>
          <option value="pipeline" ${selected(task.executionMode, 'pipeline')}>pipeline</option>
          <option value="approval-only" ${selected(task.executionMode, 'approval-only')} ${disableApprovalOnly ? 'disabled' : ''}>approval-only</option>
        </select>
      </div>

      ${renderExecutionField('command', task.executionMode, 'command', 'command', task.command, `${prefix}-command`, task.executionMode === 'approval-only')}
      ${renderExecutionField('run', task.executionMode, 'run', 'run', task.run, `${prefix}-run`, task.executionMode === 'approval-only')}
      ${renderExecutionField('pipeline', task.executionMode, 'pipeline', 'pipeline', task.pipeline, `${prefix}-pipeline`, task.executionMode === 'approval-only')}

      <div class="field-group">
        <label for="${prefix}-approval">Approval prompt</label>
        <input id="${prefix}-approval" data-task-field="approvalPrompt" value="${escapeHtml(task.approvalPrompt)}" placeholder="${disableApprovalOnly ? 'Not supported inside loop bodies' : 'Optional unless approval-only'}" ${disableApprovalOnly ? 'disabled' : ''} />
      </div>
      <div class="field-group">
        <label for="${prefix}-stdin">stdin reference</label>
        <input id="${prefix}-stdin" data-task-field="stdin" value="${escapeHtml(task.stdin)}" placeholder="$task_1.stdout" />
      </div>
      <div class="field-group">
        <label for="${prefix}-condition-field">Conditional field</label>
        <select id="${prefix}-condition-field" data-condition-field>
          <option value="when" ${task.conditionField === 'when' ? 'selected' : ''}>when</option>
          <option value="condition" ${task.conditionField === 'condition' ? 'selected' : ''}>condition</option>
        </select>
      </div>
      <div class="field-group">
        <label for="${prefix}-condition-text">Condition value</label>
        <input id="${prefix}-condition-text" data-task-field="conditionText" value="${escapeHtml(task.conditionText)}" placeholder="$approve.approved" />
      </div>
    </div>
  `;
}

function renderChildTask(task: EditorTask, parentIndex: number, childIndex: number, total: number) {
  const prefix = `child-${parentIndex}-${childIndex}`;
  return `
    <article class="task-card task-card--child" data-parent-task-index="${parentIndex}" data-child-task-index="${childIndex}">
      <div class="task-card__header">
        <div class="task-card__title">
          <span class="task-card__badge">${parentIndex + 1}.${childIndex + 1}</span>
          <strong>${escapeHtml(task.id || `task_${childIndex + 1}`)}</strong>
        </div>
        <div class="task-card__actions">
          <button type="button" data-move-child-task="-1" ${childIndex === 0 ? 'disabled' : ''}>Move up</button>
          <button type="button" data-move-child-task="1" ${childIndex === total - 1 ? 'disabled' : ''}>Move down</button>
          <button type="button" data-remove-child-task ${total === 1 ? 'disabled' : ''}>Delete</button>
        </div>
      </div>
      ${renderLeafTask(task, prefix, true)}
    </article>
  `;
}

function renderTopLevelTask(task: EditorTask, index: number, total: number) {
  const prefix = `task-${index}`;
  const body = task.kind === 'for-each'
    ? `
      <div class="task-grid">
        <div class="field-group">
          <label for="${prefix}-id">Loop id</label>
          <input id="${prefix}-id" data-task-field="id" value="${escapeHtml(task.id)}" />
        </div>
        <div class="field-group field-group--full">
          <label for="${prefix}-for-each">for_each source</label>
          <input id="${prefix}-for-each" data-task-field="forEach" value="${escapeHtml(task.forEach)}" placeholder="$fetch.stdout" />
        </div>
        <div class="field-group">
          <label for="${prefix}-condition-field">Conditional field</label>
          <select id="${prefix}-condition-field" data-condition-field>
            <option value="when" ${task.conditionField === 'when' ? 'selected' : ''}>when</option>
            <option value="condition" ${task.conditionField === 'condition' ? 'selected' : ''}>condition</option>
          </select>
        </div>
        <div class="field-group">
          <label for="${prefix}-condition-text">Condition value</label>
          <input id="${prefix}-condition-text" data-task-field="conditionText" value="${escapeHtml(task.conditionText)}" placeholder="$approve.approved" />
        </div>
      </div>
      <div class="nested-stack">
        <div class="stack-header">
          <h3>Loop body tasks</h3>
          <button type="button" data-add-child-task>Add child task</button>
        </div>
        <div class="field-help">
          The first child task receives the current loop item on stdin automatically unless you set an explicit stdin value.
        </div>
        ${task.childTasks.map((child, childIndex) => renderChildTask(child, index, childIndex, task.childTasks.length)).join('')}
      </div>
    `
    : renderLeafTask(task, prefix);

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

      <div class="field-group">
        <label for="${prefix}-kind">Task type</label>
        <select id="${prefix}-kind" data-task-kind>
          <option value="task" ${selected(task.kind, 'task')}>task</option>
          <option value="for-each" ${selected(task.kind, 'for-each')}>for-each loop</option>
        </select>
      </div>

      ${body}
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

  const saveDisabled = !!exportError;
  const testDisabled = !!exportError;
  const testClass = state.testStatus === 'success'
    ? 'status status--success'
    : state.testStatus === 'error'
      ? 'status status--error'
      : state.testStatus === 'unsupported'
        ? 'status status--warning'
        : 'status';

  root.innerHTML = `
    <div class="page">
      <main class="panel">
        <section class="hero">
          <div class="eyebrow">v0.2 maintenance editor</div>
          <h1>Lobster Studio</h1>
          <p>
            Open existing <code>.lobster</code> workflows, edit them as ordered task cards,
            save back to disk, and run a minimal in-Studio test.
          </p>
          <div class="hero-actions">
            <button type="button" id="open-file">Open .lobster</button>
          </div>
          <div class="hero-meta">
            <div><strong>Current file:</strong> ${escapeHtml(state.currentFileName || fileName)}</div>
            <div><strong>File status:</strong> ${escapeHtml(exportError || state.fileStatus)}</div>
          </div>
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
            ${state.tasks.map((task, index) => renderTopLevelTask(task, index, state.tasks.length)).join('')}
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
              Export target: <strong>${escapeHtml(fileName)}</strong>
            </div>
          </div>
          <div class="panel__section">
            <textarea class="export-preview" readonly>${escapeHtml(text)}</textarea>
            <div class="status ${exportError ? 'status--error' : ''}">
              ${escapeHtml(exportError || state.copyStatus)}
            </div>
            <div class="export-actions">
              <button type="button" id="copy-export" ${exportError ? 'disabled' : ''}>Copy .lobster</button>
            </div>
          </div>
          <div class="panel__section">
            <div class="section-header">
              <h2>Test result</h2>
            </div>
            <div class="session-actions">
              <button type="button" id="run-test" ${testDisabled ? 'disabled' : ''}>Test</button>
            </div>
            <div class="${testClass}">${escapeHtml(state.testMessage)}</div>
            ${state.testOutput
              ? `<textarea class="test-output" readonly>${escapeHtml(state.testOutput)}</textarea>`
              : ''}
          </div>
          <div class="panel__section">
            <div class="hint-card">
              Open/save uses the browser File System Access API. Test runs the current working copy
              through the local Studio preview server.
            </div>
          </div>
          <div class="panel__section panel__section--footer">
            <button type="button" class="button-primary" id="save-file" ${saveDisabled ? 'disabled' : ''}>
              Save
            </button>
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

  root.querySelector('#open-file')?.addEventListener('click', () => actions.onOpenFile());
  if (!saveDisabled) {
    root.querySelector('#save-file')?.addEventListener('click', () => actions.onSaveFile(fileName, text));
  }
  if (!testDisabled) {
    root.querySelector('#run-test')?.addEventListener('click', () => actions.onRunTest(text));
  }

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
    if (Number.isNaN(index)) continue;

    card.querySelector('[data-remove-task]')?.addEventListener('click', () => actions.onRemoveTask(index));
    card.querySelector('[data-add-child-task]')?.addEventListener('click', () => actions.onAddChildTask(index));
    Array.from(card.querySelectorAll<HTMLElement>('[data-move-task]')).forEach((button) => {
      button.addEventListener('click', () => {
        actions.onMoveTask(index, Number(button.dataset.moveTask) as -1 | 1);
      });
    });
    Array.from(card.querySelectorAll('[data-task-field]')).forEach((input) => {
      const fieldTarget = input as HTMLInputElement | HTMLTextAreaElement;
      if (fieldTarget.closest('[data-child-task-index]')) return;
      const field = fieldTarget.dataset.taskField as keyof EditorTask;
      fieldTarget.addEventListener('change', (event) =>
        actions.onTaskFieldChange(index, field, (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value ?? ''),
      );
    });
    (card.querySelector('[data-task-kind]') as HTMLSelectElement | null)?.addEventListener('change', (event) => {
      actions.onTaskKindChange(index, ((event.currentTarget as HTMLSelectElement).value ?? 'task') as EditorTaskKind);
    });
    Array.from(card.querySelectorAll('[data-task-mode]')).forEach((element) => {
      const select = element as HTMLSelectElement;
      if (select.closest('[data-child-task-index]')) return;
      select.addEventListener('change', (event) => {
        actions.onExecutionModeChange(index, ((event.currentTarget as HTMLSelectElement).value ?? 'command') as SupportedExecutionMode);
      });
    });
    Array.from(card.querySelectorAll('[data-condition-field]')).forEach((element) => {
      const select = element as HTMLSelectElement;
      if (select.closest('[data-child-task-index]')) return;
      select.addEventListener('change', (event) => {
        actions.onConditionFieldChange(index, ((event.currentTarget as HTMLSelectElement).value ?? 'when') as 'when' | 'condition');
      });
    });
  }

  for (const card of Array.from(root.querySelectorAll<HTMLElement>('[data-parent-task-index][data-child-task-index]'))) {
    const index = Number(card.dataset.parentTaskIndex);
    const childIndex = Number(card.dataset.childTaskIndex);
    if (Number.isNaN(index) || Number.isNaN(childIndex)) continue;

    card.querySelector('[data-remove-child-task]')?.addEventListener('click', () => actions.onRemoveChildTask(index, childIndex));
    Array.from(card.querySelectorAll<HTMLElement>('[data-move-child-task]')).forEach((button) => {
      button.addEventListener('click', () => {
        actions.onMoveChildTask(index, childIndex, Number(button.dataset.moveChildTask) as -1 | 1);
      });
    });
    Array.from(card.querySelectorAll('[data-task-field]')).forEach((input) => {
      const fieldTarget = input as HTMLInputElement | HTMLTextAreaElement;
      const field = fieldTarget.dataset.taskField as keyof EditorTask;
      fieldTarget.addEventListener('change', (event) =>
        actions.onChildTaskFieldChange(index, childIndex, field, (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value ?? ''),
      );
    });
    (card.querySelector('[data-task-mode]') as HTMLSelectElement | null)?.addEventListener('change', (event) => {
      actions.onChildExecutionModeChange(index, childIndex, ((event.currentTarget as HTMLSelectElement).value ?? 'command') as SupportedExecutionMode);
    });
    (card.querySelector('[data-condition-field]') as HTMLSelectElement | null)?.addEventListener('change', (event) => {
      actions.onChildConditionFieldChange(index, childIndex, ((event.currentTarget as HTMLSelectElement).value ?? 'when') as 'when' | 'condition');
    });
  }

  if (!exportError) {
    root.querySelector('#copy-export')?.addEventListener('click', () => actions.onCopyExport(text));
  }
}
