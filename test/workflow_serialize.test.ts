import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addArg,
  addEnv,
  addTask,
  createInitialEditorState,
  setTaskConditionField,
  setTaskExecutionMode,
  updateArg,
  updateEnv,
  updateTaskField,
} from '../apps/lobster-studio/src/editor-state.js';
import { editorStateToWorkflowFile, exportEditorState } from '../apps/lobster-studio/src/export.js';
import { setConditionalField, validateSupportedWorkflowFile } from '../src/workflows/serialize.js';
import { loadWorkflowFile } from '../src/workflows/file.js';

test('editor state exports workflow fields and keeps one condition alias per task', () => {
  let state = createInitialEditorState();
  state = addTask(addTask(state));
  state = addArg(state);
  state = addEnv(state);

  state = updateArg(state, state.args[0].id, 'key', 'location');
  state = updateArg(state, state.args[0].id, 'defaultValue', 'Phoenix');
  state = updateArg(state, state.args[0].id, 'description', 'default city');
  state = updateEnv(state, state.env[0].id, 'key', 'OPENCLAW_URL');
  state = updateEnv(state, state.env[0].id, 'value', 'http://127.0.0.1:18789');

  state = updateTaskField(state, 0, 'id', 'fetch');
  state = updateTaskField(state, 0, 'command', 'weather --json ${location}');

  state = updateTaskField(state, 1, 'id', 'confirm');
  state = setTaskExecutionMode(state, 1, 'approval-only');
  state = updateTaskField(state, 1, 'approvalPrompt', 'Proceed?');
  state = updateTaskField(state, 1, 'stdin', '$fetch.json');

  state = updateTaskField(state, 2, 'id', 'advice');
  state = setTaskExecutionMode(state, 2, 'pipeline');
  state = updateTaskField(state, 2, 'pipeline', 'llm.invoke --prompt "Summarize this weather"');
  state = updateTaskField(state, 2, 'stdin', '$fetch.json');
  state = setTaskConditionField(state, 2, 'condition');
  state = updateTaskField(state, 2, 'conditionText', '$confirm.approved');

  const workflow = editorStateToWorkflowFile(state);

  assert.deepEqual(workflow.args, {
    location: { default: 'Phoenix', description: 'default city' },
  });
  assert.deepEqual(workflow.env, {
    OPENCLAW_URL: 'http://127.0.0.1:18789',
  });
  assert.equal(workflow.steps[0].command, 'weather --json ${location}');
  assert.equal(workflow.steps[1].approval, 'Proceed?');
  assert.equal(workflow.steps[2].pipeline, 'llm.invoke --prompt "Summarize this weather"');
  assert.equal(workflow.steps[2].condition, '$confirm.approved');
  assert.equal('when' in workflow.steps[2], false);
});

test('workflow export text is deterministic and accepted as a .lobster file', async () => {
  let state = createInitialEditorState();
  state = addTask(addTask(state));

  state = updateTaskField(state, 0, 'id', 'fetch');
  state = setTaskExecutionMode(state, 0, 'run');
  state = updateTaskField(state, 0, 'run', 'node -e "process.stdout.write(JSON.stringify({ok:true}))"');

  state = updateTaskField(state, 1, 'id', 'approve_step');
  state = setTaskExecutionMode(state, 1, 'approval-only');
  state = updateTaskField(state, 1, 'approvalPrompt', 'Continue?');

  state = updateTaskField(state, 2, 'id', 'finish');
  state = setTaskExecutionMode(state, 2, 'command');
  state = updateTaskField(state, 2, 'command', 'node -e "process.stdout.write(JSON.stringify({done:true}))"');
  state = setTaskConditionField(state, 2, 'when');
  state = updateTaskField(state, 2, 'conditionText', '$approve_step.approved');

  const firstExport = exportEditorState(state).text;
  const secondExport = exportEditorState(state).text;

  assert.equal(firstExport, secondExport);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-visual-export-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, firstExport, 'utf8');

  const workflow = await loadWorkflowFile(filePath);
  assert.equal(workflow.steps.length, 3);
  assert.equal(workflow.steps[1].approval, 'Continue?');
  assert.equal(workflow.steps[2].when, '$approve_step.approved');
});

test('shared workflow validation rejects multiple execution fields on one task', () => {
  assert.throws(
    () =>
      validateSupportedWorkflowFile({
        steps: [
          {
            id: 'bad',
            run: 'echo hi',
            pipeline: 'json',
          },
        ],
      }),
    /can only define one of run, command, or pipeline/,
  );
});

test('conditional field helper emits only one alias at a time', () => {
  const step = setConditionalField(
    {
      id: 'finish',
      condition: '$old.value',
    },
    'when',
    '$approve_step.approved',
  );

  assert.equal(step.when, '$approve_step.approved');
  assert.equal('condition' in step, false);
});
