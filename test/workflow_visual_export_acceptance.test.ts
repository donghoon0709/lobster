import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addChildTask,
  addArg,
  addEnv,
  addTask,
  createInitialEditorState,
  setChildTaskExecutionMode,
  setTaskKind,
  setTaskConditionField,
  setTaskExecutionMode,
  updateArg,
  updateChildTaskField,
  updateEnv,
  updateTaskField,
} from '../apps/lobster-studio/src/editor-state.js';
import { exportEditorState } from '../apps/lobster-studio/src/export.js';
import { loadWorkflowFile } from '../src/workflows/file.js';
import type { WorkflowForEachStep, WorkflowStep } from '../src/workflows/types.js';

function isForEachStep(step: WorkflowStep): step is WorkflowForEachStep {
  return 'for_each' in step;
}

test('visual editor export produces a .lobster file accepted by the runtime loader', async () => {
  let state = createInitialEditorState();
  state = updateTaskField(state, 0, 'id', 'fetch');
  state = updateTaskField(state, 0, 'command', 'weather --json ${location}');

  state = addTask(state);
  state = updateTaskField(state, 1, 'id', 'approve');
  state = setTaskExecutionMode(state, 1, 'approval-only');
  state = updateTaskField(state, 1, 'approvalPrompt', 'Proceed?');
  state = updateTaskField(state, 1, 'stdin', '$fetch.json');

  state = addTask(state);
  state = updateTaskField(state, 2, 'id', 'advice');
  state = setTaskExecutionMode(state, 2, 'pipeline');
  state = updateTaskField(state, 2, 'pipeline', 'llm.invoke --prompt "Return JSON."');
  state = setTaskConditionField(state, 2, 'when');
  state = updateTaskField(state, 2, 'conditionText', '$approve.approved');
  state = updateTaskField(state, 2, 'stdin', '$fetch.json');

  state = addArg(state);
  state = updateArg(state, state.args[0].id, 'key', 'location');
  state = updateArg(state, state.args[0].id, 'defaultValue', 'Seoul');

  state = addEnv(state);
  state = updateEnv(state, state.env[0].id, 'key', 'OPENCLAW_URL');
  state = updateEnv(state, state.env[0].id, 'value', 'http://127.0.0.1:18789');

  const { fileName, text } = exportEditorState(state);
  assert.equal(fileName, 'sample-workflow.lobster');
  assert.match(text, /^name: sample-workflow/m);
  assert.match(text, /^steps:/m);
  assert.doesNotMatch(text, /^\s*\{/);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-visual-export-'));
  const filePath = path.join(tmpDir, fileName);
  await fsp.writeFile(filePath, text, 'utf8');

  const loaded = await loadWorkflowFile(filePath);
  assert.equal(loaded.steps.length, 3);
  assert.equal(loaded.steps[0].command, 'weather --json ${location}');
  assert.equal(loaded.steps[1].approval, 'Proceed?');
  assert.equal(loaded.steps[2].pipeline, 'llm.invoke --prompt "Return JSON."');
  assert.equal(loaded.steps[2].when, '$approve.approved');
  assert.equal(loaded.args?.location?.default, 'Seoul');
  assert.equal(loaded.env?.OPENCLAW_URL, 'http://127.0.0.1:18789');
});

test('visual editor exports for-each loop workflows accepted by the runtime loader', async () => {
  let state = createInitialEditorState();
  state = updateTaskField(state, 0, 'id', 'fetch');
  state = updateTaskField(state, 0, 'command', 'node -e "process.stdout.write(JSON.stringify([{id:1},{id:2}]))"');

  state = addTask(state);
  state = setTaskKind(state, 1, 'for-each');
  state = updateTaskField(state, 1, 'id', 'summaries');
  state = updateTaskField(state, 1, 'forEach', '$fetch.stdout');
  state = updateChildTaskField(state, 1, 0, 'id', 'summarize_one');
  state = setChildTaskExecutionMode(state, 1, 0, 'pipeline');
  state = updateChildTaskField(state, 1, 0, 'pipeline', 'llm.invoke --prompt "Summarize this item"');

  state = addChildTask(state, 1);
  state = updateChildTaskField(state, 1, 1, 'id', 'normalize_one');
  state = updateChildTaskField(state, 1, 1, 'command', 'node -e "process.stdout.write(process.stdin.read() || \'\')"');
  state = updateChildTaskField(state, 1, 1, 'stdin', '$summarize_one.stdout');
  state = setTaskConditionField(state, 1, 'when');
  state = updateTaskField(state, 1, 'conditionText', '$fetch.skipped');

  const { fileName, text } = exportEditorState(state);
  assert.match(text, /^\s+for_each: \$fetch\.stdout$/m);
  assert.match(text, /^\s+steps:$/m);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-visual-export-loop-'));
  const filePath = path.join(tmpDir, fileName);
  await fsp.writeFile(filePath, text, 'utf8');

  const loaded = await loadWorkflowFile(filePath);
  const loopStep = loaded.steps[1];
  assert.equal(isForEachStep(loopStep), true);
  if (!isForEachStep(loopStep)) throw new Error('expected loop step');
  assert.equal(loopStep.for_each, '$fetch.stdout');
  assert.equal(loopStep.when, '$fetch.skipped');
  assert.equal(loopStep.steps.length, 2);
  assert.equal(loopStep.steps[0].pipeline, 'llm.invoke --prompt "Summarize this item"');
  assert.equal(loopStep.steps[1].stdin, '$summarize_one.stdout');
});
