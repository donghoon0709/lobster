import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runLobster(args: string[], opts?: { env?: Record<string, string | undefined> }) {
  return spawnSync(process.execPath, [path.join('bin', 'lobster.js'), ...args], {
    cwd: path.resolve('.'),
    env: { ...process.env, ...(opts?.env ?? undefined) },
    encoding: 'utf8',
  });
}

test('human-mode workflow failure prints enriched failing-step diagnostics', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-human-failure-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  const workflow = [
    'name: failing-workflow',
    'args:',
    '  name:',
    '    default: DEFAULT',
    'steps:',
    `  - id: prepare`,
    `    command: "printf 'payload-from-prepare'"`,
    `  - id: fail_step`,
    '    command: >',
    '      node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c);process.stdin.on(\'end\',()=>{process.stdout.write(\'stdout for ${name}\');process.stderr.write(\'stderr for ${name}\');process.exit(1);});"',
    '    stdin: $prepare.stdout',
    '',
  ].join('\n');

  await fsp.writeFile(filePath, workflow, 'utf8');

  const result = runLobster([
    'run',
    '--file',
    filePath,
    '--args-json',
    '{"name":"Kim"}',
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Workflow failed at step fail_step \[shell\]/);
  assert.match(result.stderr, /Original: node -e/);
  assert.match(result.stderr, /stdout for \$\{name\}/);
  assert.match(result.stderr, /Resolved: node -e/);
  assert.match(result.stderr, /stdout for Kim/);
  assert.match(result.stderr, /stdin preview:/);
  assert.match(result.stderr, /payload-from-prepare/);
  assert.match(result.stderr, /stdout:/);
  assert.match(result.stderr, /stdout for Kim/);
  assert.match(result.stderr, /stderr:/);
  assert.match(result.stderr, /stderr for Kim/);
  assert.doesNotMatch(result.stderr, /^Error:/m);
});

test('human-mode --verbose prints post-run summaries on success', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-human-verbose-success-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  const workflow = `name: verbose-success
steps:
  - id: prepare
    command: "printf 'alpha'"
  - id: finish
    command: "printf 'omega'"
    stdin: $prepare.stdout
`;

  await fsp.writeFile(filePath, workflow, 'utf8');

  const result = runLobster([
    'run',
    '--file',
    filePath,
    '--verbose',
  ]);

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['omega']);
  assert.match(result.stderr, /Workflow step summary:/);
  assert.match(result.stderr, /- prepare \[shell\] succeeded/);
  assert.match(result.stderr, /- finish \[shell\] succeeded/);
  assert.match(result.stderr, /stdin:/);
  assert.match(result.stderr, /alpha/);
  assert.doesNotMatch(result.stderr, /original:/i);
  assert.doesNotMatch(result.stderr, /resolved:/i);
});

test('human-mode --verbose prints summaries before enriched failure block', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-human-verbose-failure-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  const workflow = `name: verbose-failure
steps:
  - id: first
    command: "printf 'first-output'"
  - id: boom
    command: >
      node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('before-boom');process.stderr.write('kaboom');process.exit(1);});"
    stdin: $first.stdout
`;

  await fsp.writeFile(filePath, workflow, 'utf8');

  const result = runLobster([
    'run',
    '--file',
    filePath,
    '--verbose',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workflow step summary:/);
  assert.match(result.stderr, /- first \[shell\] succeeded/);
  assert.match(result.stderr, /- boom \[shell\] failed/);
  assert.match(result.stderr, /Workflow failed at step boom \[shell\]/);
  assert.doesNotMatch(result.stderr, /original:/i);
  assert.doesNotMatch(result.stderr, /resolved:/i);
  assert.ok(
    result.stderr.indexOf('Workflow step summary:') < result.stderr.indexOf('Workflow failed at step boom [shell]'),
    result.stderr,
  );
});

test('human-mode --verbose colors step labels and statuses when FORCE_COLOR is enabled', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-human-verbose-color-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  const workflow = `name: verbose-color
steps:
  - id: prepare
    command: "printf 'alpha'"
  - id: finish
    command: "printf 'omega'"
    stdin: $prepare.stdout
`;

  await fsp.writeFile(filePath, workflow, 'utf8');

  const result = runLobster([
    'run',
    '--file',
    filePath,
    '--verbose',
  ], {
    env: {
      FORCE_COLOR: '1',
    },
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, new RegExp(`${String.raw`\u001B\[1m`}prepare \\[shell\\]${String.raw`\u001B\[0m`}`));
  assert.match(result.stderr, new RegExp(`${String.raw`\u001B\[32m`}succeeded${String.raw`\u001B\[0m`}`));
});
